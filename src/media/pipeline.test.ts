import { findMediaById, insertAgent, insertMedia, listDerivatives, type Db } from '$db';
import { freshDatabase } from '$db/testing';
import { EventBus, type EventPayloads } from '$events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeriveOutcome } from './derive';
import { ingest } from './ingest';
import { originalFile } from './paths';
import {
	DERIVATIVE_BATCH,
	DerivativePipeline,
	WORKER_INTERVAL_MS,
	processPendingMedia,
	startDerivativeWorker
} from './pipeline';
import { openVariant } from './serve';
import { bodyOf, exifImageBytes, sampleVideoBytes, tempSettings } from './testing';
import { createUpload } from './upload';

let db: Db;
let agentId: string;
let bus: EventBus;
let temp: ReturnType<typeof tempSettings>;
let settings: ReturnType<typeof tempSettings>['settings'];
let ready: EventPayloads['media.ready'][];

beforeEach(() => {
	db = freshDatabase();
	agentId = insertAgent(db, { name: 'uploader', tokenHash: 'hash' }).id;
	bus = new EventBus();
	ready = [];
	bus.subscribe((event) => {
		if (event.type === 'media.ready') ready.push(event.payload);
	});
	temp = tempSettings({ maxImageBytes: 4 * 1024 * 1024, maxVideoBytes: 8 * 1024 * 1024 });
	settings = temp.settings;
});

afterEach(() => {
	db.close();
	temp.cleanup();
});

async function uploaded(bytes: Uint8Array, mime: string, filename = 'shot.bin') {
	const created = createUpload(settings, { db, agentId, filename, mime, bytes: bytes.length });
	await ingest(settings, { db, token: created.token, body: bodyOf(bytes) });
	return created.mediaId;
}

/** An upload that landed, whose bytes are then replaced with rubbish. */
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

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

describe('DerivativePipeline', () => {
	it('runs two media at once and leaves the third queued (design §6)', async () => {
		const gates = new Map<string, ReturnType<typeof deferred>>();
		const started: string[] = [];
		const pipeline = new DerivativePipeline({
			db,
			settings,
			bus,
			derive: async (_settings, options): Promise<DeriveOutcome> => {
				started.push(options.id);
				const gate = deferred();
				gates.set(options.id, gate);
				await gate.promise;
				return {
					status: 'ready',
					mediaId: options.id,
					variants: [],
					width: null,
					height: null,
					durationMs: null,
					published: true
				};
			}
		});

		const ids = [
			await uploaded(await exifImageBytes(), 'image/png', 'a.png'),
			await uploaded(await exifImageBytes({ width: 900, height: 900 }), 'image/png', 'b.png'),
			await uploaded(await exifImageBytes({ width: 800, height: 800 }), 'image/png', 'c.png')
		];

		const submitted = pipeline.enqueuePending();
		expect(submitted).toEqual(ids);

		expect(pipeline.concurrency).toBe(2);
		expect(started).toEqual([ids[0], ids[1]]);
		expect(pipeline.running).toBe(2);
		expect(pipeline.queued).toBe(1);

		gates.get(ids[0])!.resolve();
		await vi.waitFor(() => expect(started).toHaveLength(3));

		expect(pipeline.queued).toBe(0);
		for (const gate of gates.values()) gate.resolve();
		await pipeline.drain();
		expect(pipeline.running).toBe(0);
	});

	it('never submits the same media twice while it is still running', async () => {
		const gate = deferred();
		const derive = vi.fn(async (): Promise<DeriveOutcome> => {
			await gate.promise;
			return { status: 'skipped', mediaId: 'x', reason: 'stub' };
		});
		const pipeline = new DerivativePipeline({ db, settings, bus, derive });
		await uploaded(await exifImageBytes(), 'image/png', 'a.png');

		pipeline.enqueuePending();
		pipeline.enqueuePending();
		pipeline.enqueuePending();

		expect(derive).toHaveBeenCalledTimes(1);
		gate.resolve();
		await pipeline.drain();
	});

	it('leaves reservations whose bytes never landed alone', async () => {
		const reserved = createUpload(settings, {
			db,
			agentId,
			filename: 'never.png',
			mime: 'image/png',
			bytes: 10
		});
		const real = await uploaded(await exifImageBytes(), 'image/png', 'a.png');

		const pipeline = new DerivativePipeline({ db, settings, bus });

		expect(pipeline.enqueuePending()).toEqual([real]);
		await pipeline.drain();
		expect(findMediaById(db, reserved.mediaId)!.status).toBe('pending');
	});

	it('is bounded, so a neglected deployment does not queue everything at once', async () => {
		await uploaded(await exifImageBytes(), 'image/png', 'a.png');
		await uploaded(await exifImageBytes({ width: 900, height: 900 }), 'image/png', 'b.png');

		const pipeline = new DerivativePipeline({ db, settings, bus });

		expect(pipeline.enqueuePending({ limit: 1 })).toHaveLength(1);
		await pipeline.drain();
		expect(DERIVATIVE_BATCH).toBeGreaterThan(1);
	});
});

describe('processPendingMedia', () => {
	it('derives media that was already on disk before this slice existed', async () => {
		// The backlog case: rows uploaded by an earlier version, sitting at
		// `pending` with no derivatives and nothing about to enqueue them.
		const image = await uploaded(await exifImageBytes(), 'image/png', 'shot.png');
		const video = await uploaded(await sampleVideoBytes({ seconds: 1 }), 'video/mp4', 'clip.mp4');

		const result = await processPendingMedia(settings, { db, bus });

		expect(result).toMatchObject({ submitted: 2, ready: 2, failed: 0 });
		expect(findMediaById(db, image)!.status).toBe('ready');
		expect(findMediaById(db, video)!.status).toBe('ready');

		expect(listDerivatives(db, image).map((row) => row.width)).toEqual([640, 1600]);
		expect(
			(await openVariant(settings, { db, id: image, variant: 'thumb-640' })).bytes
		).toBeGreaterThan(0);
		expect(
			(await openVariant(settings, { db, id: video, variant: 'poster' })).bytes
		).toBeGreaterThan(0);
		expect(ready.map((event) => event.mediaId).sort()).toEqual([image, video].sort());
	});

	it('marks a corrupt file failed and still finishes everything else', async () => {
		const broken = planted(new TextEncoder().encode('nope'), 'image/png');
		const good = await uploaded(await exifImageBytes(), 'image/png', 'shot.png');
		const alsoGood = await uploaded(await sampleVideoBytes(), 'video/mp4', 'clip.mp4');

		const result = await processPendingMedia(settings, { db, bus });

		expect(result).toMatchObject({ submitted: 3, ready: 2, failed: 1 });
		expect(findMediaById(db, broken)!.status).toBe('failed');
		expect(findMediaById(db, good)!.status).toBe('ready');
		expect(findMediaById(db, alsoGood)!.status).toBe('ready');
		expect(ready.map((event) => event.mediaId).sort()).toEqual([good, alsoGood].sort());
	});

	it('publishes media.ready exactly once even when run twice', async () => {
		const id = await uploaded(await exifImageBytes(), 'image/png', 'shot.png');

		await processPendingMedia(settings, { db, bus });
		const second = await processPendingMedia(settings, { db, bus });

		expect(second).toMatchObject({ submitted: 0, ready: 0 });
		expect(ready.filter((event) => event.mediaId === id)).toHaveLength(1);
	});

	it('reports nothing to do on an empty deployment', async () => {
		await expect(processPendingMedia(settings, { db, bus })).resolves.toEqual({
			submitted: 0,
			ready: 0,
			failed: 0,
			skipped: 0
		});
	});
});

describe('startDerivativeWorker', () => {
	it('picks up pending media on its own and stops when told', async () => {
		const id = await uploaded(await exifImageBytes(), 'image/png', 'shot.png');

		const stop = startDerivativeWorker({
			intervalMs: 5,
			db: () => db,
			settings: () => settings,
			bus,
			onSweep: () => {}
		});

		try {
			// The event, not the row: `media.ready` is what a browser is waiting for,
			// and it is the last thing a successful run does.
			await vi.waitFor(() => expect(ready).toHaveLength(1), { timeout: 10_000 });
		} finally {
			stop();
		}

		expect(findMediaById(db, id)!.status).toBe('ready');
		expect(ready[0]).toMatchObject({ mediaId: id, kind: 'image' });

		// Stopped means stopped: a second upload is not picked up.
		const later = await uploaded(
			await exifImageBytes({ width: 700, height: 700 }),
			'image/png',
			'b.png'
		);
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(findMediaById(db, later)!.status).toBe('pending');
	});

	it('survives a broken environment instead of taking the server down with it', async () => {
		const onError = vi.fn();
		const stop = startDerivativeWorker({
			intervalMs: 5,
			db: () => {
				throw new Error('DATA_DIR is not set');
			},
			bus,
			onError,
			onSweep: () => {}
		});

		try {
			await vi.waitFor(() => expect(onError).toHaveBeenCalled());
		} finally {
			stop();
		}

		expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
	});

	it('polls often enough for the browser swap to feel live', () => {
		expect(WORKER_INTERVAL_MS).toBeLessThanOrEqual(5_000);
	});
});
