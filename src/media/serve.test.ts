import { insertAgent, insertDerivative, insertMedia, setMediaStatus, type Db } from '$db';
import { freshDatabase } from '$db/testing';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isMediaError, type MediaErrorCode } from './errors';
import { ingest } from './ingest';
import { derivativeFile } from './paths';
import { VARIANTS, derivativesFor, isVariant, openVariant } from './serve';
import { bodyOf, pngBytes, tempSettings, webpBytes } from './testing';
import { createUpload } from './upload';

const NOW = Date.UTC(2026, 7, 25, 9, 30, 0);

let db: Db;
let agentId: string;
let temp: ReturnType<typeof tempSettings>;
let settings: ReturnType<typeof tempSettings>['settings'];

beforeEach(() => {
	db = freshDatabase();
	agentId = insertAgent(db, { name: 'uploader', tokenHash: 'hash' }).id;
	temp = tempSettings();
	settings = temp.settings;
});

afterEach(() => {
	db.close();
	temp.cleanup();
});

/** Reserve, upload, and hand back the media id — the state serving starts from. */
async function uploaded(bytes = pngBytes(), mime = 'image/png'): Promise<string> {
	const created = createUpload(settings, {
		db,
		agentId,
		filename: 'shot.png',
		mime,
		bytes: bytes.length,
		now: NOW
	});
	await ingest(settings, { db, token: created.token, body: bodyOf(bytes), now: NOW });
	return created.mediaId;
}

async function refusal(body: () => Promise<unknown>): Promise<MediaErrorCode | undefined> {
	try {
		await body();
		return undefined;
	} catch (error) {
		if (!isMediaError(error)) throw error;
		return error.code;
	}
}

async function read(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	const reader = stream.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
	}
	return new Uint8Array(Buffer.concat(chunks));
}

describe('serving the original', () => {
	it('hands back the bytes, the type they really are, and a stable etag', async () => {
		const bytes = pngBytes();
		const id = await uploaded(bytes);

		const file = await openVariant(settings, { db, id, variant: 'original' });

		expect(file.mime).toBe('image/png');
		expect(file.bytes).toBe(bytes.length);
		expect(await read(file.open())).toEqual(bytes);

		const again = await openVariant(settings, { db, id, variant: 'original' });
		expect(again.etag).toBe(file.etag);
	});

	it('serves a row that is still pending, because the bytes are already on disk', async () => {
		const id = await uploaded();

		await expect(openVariant(settings, { db, id, variant: 'original' })).resolves.toBeTruthy();
	});

	it('gives two different uploads two different etags', async () => {
		const first = await openVariant(settings, {
			db,
			id: await uploaded(),
			variant: 'original'
		});
		const second = await openVariant(settings, {
			db,
			id: await uploaded(webpBytes(), 'image/webp'),
			variant: 'original'
		});

		expect(second.etag).not.toBe(first.etag);
	});
});

describe('what is never served', () => {
	it('refuses an id that is unknown, malformed, or trying to climb out of the tree', async () => {
		for (const id of ['01K3ABCDEFGHJKMNPQRSTVWXYZ', '../../../etc/passwd', '', 'x']) {
			expect(await refusal(() => openVariant(settings, { db, id, variant: 'original' })), id).toBe(
				'not_found'
			);
		}
	});

	it('refuses a reservation whose bytes never arrived', async () => {
		const created = createUpload(settings, {
			db,
			agentId,
			filename: 'shot.png',
			mime: 'image/png',
			bytes: 100,
			now: NOW
		});

		expect(
			await refusal(() => openVariant(settings, { db, id: created.mediaId, variant: 'original' }))
		).toBe('not_found');
	});

	it('refuses an upload that failed', async () => {
		const id = await uploaded();
		setMediaStatus(db, id, { status: 'failed' });

		expect(await refusal(() => openVariant(settings, { db, id, variant: 'original' }))).toBe(
			'not_found'
		);
	});

	it('refuses a row whose mime is not on the allowlist, however it got there', async () => {
		// Straight into the table, as a bad migration or a future bug might.
		const media = insertMedia(db, {
			agentId,
			kind: 'image',
			mime: 'image/svg+xml',
			bytes: 10,
			sha256: 'abc',
			status: 'ready'
		});

		expect(
			await refusal(() => openVariant(settings, { db, id: media.id, variant: 'original' }))
		).toBe('not_found');
	});

	it('refuses a variant name it does not know', async () => {
		const id = await uploaded();

		expect(isVariant('original')).toBe(true);
		expect(isVariant('../../original.png')).toBe(false);
		expect(isVariant('thumb-9999')).toBe(false);
		expect(
			await refusal(() =>
				openVariant(settings, { db, id, variant: 'thumb-9999' as (typeof VARIANTS)[number] })
			)
		).toBe('not_found');
	});

	it('refuses a derivative that has not been generated yet', async () => {
		const id = await uploaded();

		for (const variant of ['thumb-640', 'thumb-1600', 'poster', 'video'] as const) {
			expect(await refusal(() => openVariant(settings, { db, id, variant })), variant).toBe(
				'not_found'
			);
		}
	});
});

describe('serving a derivative', () => {
	/** What the derivative slice (#8) will write. Serving it is this slice's half. */
	function generate(id: string, relativePath: string, bytes: Uint8Array) {
		const full = derivativeFile(settings, relativePath);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, bytes);
		insertDerivative(db, {
			mediaId: id,
			kind: 'thumb',
			path: relativePath,
			bytes: bytes.length,
			width: 640,
			height: 640
		});
	}

	it('serves it as the type that variant is always generated in', async () => {
		const id = await uploaded();
		const thumb = webpBytes();
		generate(id, `${id.slice(0, 2)}/${id}/thumb-640.webp`, thumb);

		const file = await openVariant(settings, { db, id, variant: 'thumb-640' });

		expect(file.mime).toBe('image/webp');
		expect(file.bytes).toBe(thumb.length);
		expect(await read(file.open())).toEqual(thumb);
	});

	it('lists what is actually available for a media item', async () => {
		const id = await uploaded();

		expect(derivativesFor({ db, id }).map((entry) => entry.variant)).toEqual(['original']);

		generate(id, `${id.slice(0, 2)}/${id}/thumb-640.webp`, webpBytes());

		expect(derivativesFor({ db, id }).map((entry) => entry.variant)).toEqual([
			'original',
			'thumb-640'
		]);
	});
});
