import { findMediaById, insertAgent, insertMedia, listDerivatives, type Db } from '$db';
import { freshDatabase } from '$db/testing';
import { EventBus } from '$events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { processMedia, readMediaFailure } from './derive';
import { probeVideo } from './ffmpeg';
import { ingest } from './ingest';
import { mediaDir, originalFile } from './paths';
import { openVariant } from './serve';
import {
	bodyOf,
	exifImageBytes,
	hasExifBlock,
	sampleAudioBytes,
	sampleVideoBytes,
	tempSettings
} from './testing';
import { createUpload } from './upload';

let db: Db;
let agentId: string;
let bus: EventBus;
let temp: ReturnType<typeof tempSettings>;
let settings: ReturnType<typeof tempSettings>['settings'];

beforeEach(() => {
	db = freshDatabase();
	agentId = insertAgent(db, { name: 'uploader', tokenHash: 'hash' }).id;
	bus = new EventBus();
	temp = tempSettings({ maxImageBytes: 4 * 1024 * 1024, maxVideoBytes: 8 * 1024 * 1024 });
	settings = temp.settings;
});

afterEach(() => {
	db.close();
	temp.cleanup();
});

/** A real upload: token, bytes on disk, a `pending` row. */
async function uploaded(bytes: Uint8Array, mime: string, filename = 'shot.bin') {
	const created = createUpload(settings, { db, agentId, filename, mime, bytes: bytes.length });
	await ingest(settings, { db, token: created.token, body: bodyOf(bytes) });
	return created.mediaId;
}

/** Bytes placed on disk directly, so a test can make them anything it likes. */
function planted(bytes: Uint8Array, mime: string) {
	const media = insertMedia(db, {
		agentId,
		kind: mime.startsWith('video/') ? 'video' : 'image',
		mime,
		bytes: bytes.length,
		sha256: 'f'.repeat(64)
	});
	const file = originalFile(settings, media.id, mime);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, bytes);
	return media.id;
}

/** Every `media.ready` the bus saw. */
function readyEvents() {
	const seen: Array<{ mediaId: string; kind: string }> = [];
	bus.subscribe((event) => {
		if (event.type === 'media.ready') seen.push(event.payload);
	});
	return seen;
}

describe('images', () => {
	it('produces a 640w and a 1600w webp thumbnail with the EXIF stripped', async () => {
		const source = await exifImageBytes({ format: 'png', width: 1800, height: 900 });
		expect(hasExifBlock(source), 'the fixture must actually carry EXIF').toBe(true);

		const id = await uploaded(source, 'image/png', 'screenshot.png');
		const outcome = await processMedia(settings, { db, id, bus });

		expect(outcome).toMatchObject({ status: 'ready', mediaId: id });

		const thumbs = listDerivatives(db, id).filter((row) => row.kind === 'thumb');
		expect(thumbs.map((row) => row.width)).toEqual([640, 1600]);

		for (const thumb of thumbs) {
			const file = await openVariant(settings, {
				db,
				id,
				variant: thumb.width === 640 ? 'thumb-640' : 'thumb-1600'
			});
			expect(file.mime).toBe('image/webp');
			expect(file.bytes).toBeGreaterThan(0);

			const bytes = readFileSync(`${mediaDir(settings, id)}/thumb-${thumb.width}.webp`);
			const meta = await sharp(bytes).metadata();
			expect(meta.format).toBe('webp');
			expect(meta.width).toBe(thumb.width);
			expect(meta.exif, `thumb-${thumb.width} kept its EXIF`).toBeUndefined();
			expect(hasExifBlock(bytes), `thumb-${thumb.width} kept an EXIF block`).toBe(false);
		}
	});

	it('records the dimensions of the original and flips the row to ready', async () => {
		const id = await uploaded(
			await exifImageBytes({ format: 'jpeg', width: 1200, height: 400 }),
			'image/jpeg',
			'wide.jpg'
		);

		await processMedia(settings, { db, id, bus });
		const media = findMediaById(db, id)!;

		expect(media.status).toBe('ready');
		expect(media.width).toBe(1200);
		expect(media.height).toBe(400);
		expect(media.durationMs).toBeNull();
	});

	it('publishes media.ready exactly once, however many times it is asked', async () => {
		const seen = readyEvents();
		const id = await uploaded(await exifImageBytes(), 'image/png', 'a.png');

		const first = await processMedia(settings, { db, id, bus });
		const second = await processMedia(settings, { db, id, bus });
		const third = await processMedia(settings, { db, id, bus });

		expect(first.status).toBe('ready');
		expect(second).toMatchObject({ status: 'skipped' });
		expect(third).toMatchObject({ status: 'skipped' });
		expect(seen).toEqual([
			{ mediaId: id, updateId: null, messageId: null, requestId: null, kind: 'image' }
		]);
	});

	it('reprocesses a ready row when told to, without a second media.ready', async () => {
		const seen = readyEvents();
		const id = await uploaded(await exifImageBytes(), 'image/png', 'a.png');

		await processMedia(settings, { db, id, bus });
		const again = await processMedia(settings, { db, id, bus, force: true });

		expect(again.status).toBe('ready');
		expect(seen).toHaveLength(1);
		expect(listDerivatives(db, id).filter((row) => row.kind === 'thumb')).toHaveLength(2);
	});
});

describe('video', () => {
	it('takes a poster frame and the real duration off a one-second mp4', async () => {
		const id = await uploaded(await sampleVideoBytes({ seconds: 1 }), 'video/mp4', 'clip.mp4');

		const outcome = await processMedia(settings, { db, id, bus });
		expect(outcome).toMatchObject({ status: 'ready' });

		const media = findMediaById(db, id)!;
		expect(media.durationMs).toBe(1000);
		expect(media.width).toBe(320);
		expect(media.height).toBe(240);

		const poster = await openVariant(settings, { db, id, variant: 'poster' });
		expect(poster.mime).toBe('image/jpeg');
		expect(poster.bytes).toBeGreaterThan(0);
		expect((await sharp(`${mediaDir(settings, id)}/poster.jpg`).metadata()).format).toBe('jpeg');
	});

	it('leaves an h264 mp4 alone rather than transcoding it pointlessly', async () => {
		const id = await uploaded(await sampleVideoBytes({ seconds: 1 }), 'video/mp4', 'clip.mp4');

		await processMedia(settings, { db, id, bus });

		expect(listDerivatives(db, id).map((row) => row.kind)).toEqual(['poster']);
		await expect(openVariant(settings, { db, id, variant: 'video' })).rejects.toThrow();
	});

	it('transcodes to h264 mp4 when the source is not web-playable', async () => {
		const id = await uploaded(
			await sampleVideoBytes({ seconds: 1, codec: 'mpeg4' }),
			'video/mp4',
			'legacy.mp4'
		);

		await processMedia(settings, { db, id, bus });

		const kinds = listDerivatives(db, id).map((row) => row.kind);
		expect(kinds).toContain('mp4');

		const served = await openVariant(settings, { db, id, variant: 'video' });
		expect(served.mime).toBe('video/mp4');

		const transcoded = await probeVideo(`${mediaDir(settings, id)}/video.mp4`);
		expect(transcoded.videoCodec).toBe('h264');
		expect(transcoded.durationMs).toBe(1000);
	});

	it('publishes media.ready with the video kind', async () => {
		const seen = readyEvents();
		const id = await uploaded(await sampleVideoBytes(), 'video/mp4', 'clip.mp4');

		await processMedia(settings, { db, id, bus });

		expect(seen).toEqual([
			{ mediaId: id, updateId: null, messageId: null, requestId: null, kind: 'video' }
		]);
	});
});

describe('failure', () => {
	it('marks a corrupt image failed, records the reason, and publishes nothing', async () => {
		const seen = readyEvents();
		const id = planted(new TextEncoder().encode('this is not a png at all'), 'image/png');

		const outcome = await processMedia(settings, { db, id, bus });

		expect(outcome.status).toBe('failed');
		expect(findMediaById(db, id)!.status).toBe('failed');
		expect(seen).toEqual([]);

		const reason = await readMediaFailure(settings, id);
		expect(reason).toBeTruthy();
		expect(outcome).toMatchObject({ reason: expect.any(String) });
		expect(reason).toContain((outcome as { reason: string }).reason);
	});

	it('marks a corrupt video failed with ffmpeg saying why', async () => {
		const id = planted(new TextEncoder().encode('MOOV? no.'), 'video/mp4');

		const outcome = await processMedia(settings, { db, id, bus });

		expect(outcome.status).toBe('failed');
		expect((outcome as { reason: string }).reason).toMatch(/ffprobe|ffmpeg/i);
	});

	it('never throws, so one bad file cannot escape into the queue', async () => {
		const id = planted(new Uint8Array(0), 'image/png');

		await expect(processMedia(settings, { db, id, bus })).resolves.toMatchObject({
			status: 'failed'
		});
	});

	it('clears an old failure note once the media is derived', async () => {
		const id = planted(new TextEncoder().encode('broken'), 'image/png');
		await processMedia(settings, { db, id, bus });
		expect(await readMediaFailure(settings, id)).toBeTruthy();

		writeFileSync(originalFile(settings, id, 'image/png'), await exifImageBytes());
		const retried = await processMedia(settings, { db, id, bus });

		expect(retried.status).toBe('ready');
		expect(await readMediaFailure(settings, id)).toBeUndefined();
	});
});

describe('rows it will not touch', () => {
	it('skips an id with no row', async () => {
		await expect(
			processMedia(settings, { db, id: '01JJ0000000000000000000000', bus })
		).resolves.toMatchObject({ status: 'skipped' });
	});

	it('skips a reservation whose bytes never arrived', async () => {
		const created = createUpload(settings, {
			db,
			agentId,
			filename: 'never.png',
			mime: 'image/png',
			bytes: 100
		});

		const outcome = await processMedia(settings, { db, id: created.mediaId, bus });

		expect(outcome).toMatchObject({ status: 'skipped' });
		expect(findMediaById(db, created.mediaId)!.status).toBe('pending');
		expect(existsSync(mediaDir(settings, created.mediaId))).toBe(false);
	});
});

/**
 * A file has nothing to derive (migration 026).
 *
 * It still goes through this pass, because `ready` is the status the rest of the
 * product reads — the card switches on it, the sweeper counts from it — and the
 * only way a row gets one is here. What it must not do is try: there is no
 * thumbnail for a zip, and `sharp` would say so as a `failed` row.
 */
describe('sound (migration 038)', () => {
	it('measures how long it is and becomes ready, with nothing derived', async () => {
		const bytes = await sampleAudioBytes({ seconds: 2, container: 'mp3' });
		const id = await uploaded(bytes, 'audio/mpeg', 'voice-note.mp3');
		const heard = readyEvents();

		const outcome = await processMedia(settings, { db, id, bus });

		expect(outcome).toMatchObject({ status: 'ready', variants: [] });
		// A tone of two seconds, measured rather than assumed — mp3 framing makes
		// it a shade long, so this is a range rather than an equality.
		expect(outcome.status === 'ready' && outcome.durationMs).toBeGreaterThan(1_800);
		expect(outcome.status === 'ready' && outcome.durationMs).toBeLessThan(2_400);
		// No waveform picture, no transcode: the browser plays what was uploaded.
		expect(listDerivatives(db, id)).toEqual([]);
		expect(heard).toEqual([
			{ mediaId: id, updateId: null, messageId: null, requestId: null, kind: 'audio' }
		]);
	});

	it('serves the sound inline as itself, so a player can point at it', async () => {
		const bytes = await sampleAudioBytes({ container: 'm4a' });
		// An .m4a sniffs as audio/x-m4a; declaring the canonical type must work.
		const id = await uploaded(bytes, 'audio/mp4', 'memo.m4a');
		await processMedia(settings, { db, id, bus });

		const file = await openVariant(settings, { db, id, variant: 'original' });

		expect(file.mime).toBe('audio/mp4');
		expect(file.disposition).toBe('inline');
	});

	it('takes each container the allowlist names', async () => {
		for (const [container, mime] of [
			['ogg', 'audio/ogg'],
			['wav', 'audio/wav']
		] as const) {
			const id = await uploaded(await sampleAudioBytes({ container }), mime, `tone.${container}`);

			expect(
				(await processMedia(settings, { db, id, bus })).status,
				`${container} should derive`
			).toBe('ready');
			expect(findMediaById(db, id)?.kind).toBe('audio');
		}
	});
});

describe('deriving a file', () => {
	const log = new TextEncoder().encode('line one\nline two\n');

	it('becomes ready immediately, with no derivatives and no failure', async () => {
		const id = await uploaded(log, 'text/plain', 'build.log');
		const heard: unknown[] = [];
		bus.subscribe((event) => {
			if (event.type === 'media.ready') heard.push(event.payload);
		});

		const outcome = await processMedia(settings, { db, id, bus });

		expect(outcome).toMatchObject({ status: 'ready', variants: ['original'] });
		expect(findMediaById(db, id)?.status).toBe('ready');
		expect(listDerivatives(db, id)).toEqual([]);
		expect(heard).toEqual([
			{ mediaId: id, updateId: null, messageId: null, requestId: null, kind: 'file' }
		]);
	});

	it('is still servable as itself once ready', async () => {
		const id = await uploaded(log, 'text/plain', 'build.log');
		await processMedia(settings, { db, id, bus });

		const file = await openVariant(settings, { db, id, variant: 'original' });

		expect(file.mime).toBe('application/octet-stream');
		expect(file.filename).toBe('build.log');
	});

	it('is skipped the second time, so `media.ready` fires exactly once', async () => {
		const id = await uploaded(log, 'text/plain', 'build.log');
		await processMedia(settings, { db, id, bus });

		expect(await processMedia(settings, { db, id, bus })).toMatchObject({ status: 'skipped' });
	});
});
