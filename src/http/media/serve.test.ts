import { harness, type Harness } from '$domain/testing';
import { createUpload as mintUpload, ingest, processMedia } from '$media';
import { bodyOf, exifImageBytes, pngBytes, sampleVideoBytes, tempSettings } from '$media/testing';
import { insertMedia } from '$db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE, signSession } from '../auth';
import { createMediaHandler, type MediaHandlerOptions } from './serve';

const SESSION_SECRET = 's'.repeat(32);
const authConfig = () => ({ sessionSecret: SESSION_SECRET, adminPasswordHash: '$argon2id$x' });

let ctx: Harness;
let agentId: string;
let temp: ReturnType<typeof tempSettings>;
let settings: ReturnType<typeof tempSettings>['settings'];

beforeEach(() => {
	ctx = harness();
	agentId = ctx.agent('claude');
	temp = tempSettings();
	settings = temp.settings;
});

afterEach(() => temp.cleanup());

/** An upload that really landed, as serving finds it. */
async function uploaded(bytes = pngBytes()): Promise<string> {
	const created = mintUpload(settings, {
		db: ctx.db,
		agentId,
		filename: 'shot.png',
		mime: 'image/png',
		bytes: bytes.length,
		now: ctx.now()
	});
	await ingest(settings, { db: ctx.db, token: created.token, body: bodyOf(bytes), now: ctx.now() });
	return created.mediaId;
}

type GetOptions = MediaHandlerOptions & { cookie?: string | undefined; headers?: HeadersInit };

async function get(id: string, variant: string, options: GetOptions = {}) {
	const handler = createMediaHandler({
		context: options.context ?? (() => ctx),
		settings: options.settings ?? (() => settings),
		config: options.config ?? authConfig
	});
	const cookie = 'cookie' in options ? options.cookie : signSession(SESSION_SECRET);

	return handler({
		request: new Request(`https://dash.test/media/${id}/${variant}`, { headers: options.headers }),
		params: { id, variant },
		cookies: { get: (name: string) => (name === SESSION_COOKIE ? cookie : undefined) }
	});
}

describe('GET /media/:id/:variant', () => {
	it('serves the bytes with immutable caching and every hardening header', async () => {
		const png = pngBytes();
		const id = await uploaded(png);

		const response = await get(id, 'original');

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('image/png');
		expect(response.headers.get('content-length')).toBe(String(png.length));
		expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
		expect(response.headers.get('x-content-type-options')).toBe('nosniff');
		expect(response.headers.get('content-disposition')).toBe('inline');
		expect(response.headers.get('etag')).toBeTruthy();
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);
	});

	it('answers a matching If-None-Match with 304 and no body', async () => {
		const id = await uploaded();
		const etag = (await get(id, 'original')).headers.get('etag')!;

		const response = await get(id, 'original', { headers: { 'if-none-match': etag } });

		expect(response.status).toBe(304);
		expect(response.headers.get('etag')).toBe(etag);
		expect(await response.text()).toBe('');
	});

	it('needs the owner`s session, because media is not public', async () => {
		const id = await uploaded();

		const response = await get(id, 'original', { cookie: undefined });

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: 'unauthenticated' });
	});

	it('answers 404 for an id or variant it does not serve', async () => {
		const id = await uploaded();

		for (const [target, variant] of [
			[id, 'thumb-640'],
			[id, '../../../etc/passwd'],
			[id, 'original.png'],
			['01K3ABCDEFGHJKMNPQRSTVWXYZ', 'original'],
			['../../etc/passwd', 'original'],
			['', 'original']
		]) {
			const response = await get(target, variant);

			expect(response.status, `${target}/${variant}`).toBe(404);
			expect(response.headers.get('cache-control'), `${target}/${variant}`).toBe('no-store');
		}
	});

	it('never emits a type off the allowlist, whatever the row says', async () => {
		const media = insertMedia(ctx.db, {
			agentId,
			kind: 'image',
			mime: 'image/svg+xml',
			bytes: 10,
			sha256: 'abc',
			status: 'ready'
		});

		const response = await get(media.id, 'original');

		expect(response.status).toBe(404);
	});

	it('does not claim to support ranges it does not implement', async () => {
		const id = await uploaded();

		expect((await get(id, 'original')).headers.get('accept-ranges')).toBe('none');
	});

	it('answers 503 when the deployment is not configured', async () => {
		const response = await get('01K3ABCDEFGHJKMNPQRSTVWXYZ', 'original', {
			settings: () => null
		});

		expect(response.status).toBe(503);
	});
});

describe('GET /media/:id/:variant, once derivatives exist', () => {
	/** Upload, then run the derivative pipeline over it, as the worker would. */
	async function derived(bytes: Uint8Array, mime: string): Promise<string> {
		const created = mintUpload(settings, {
			db: ctx.db,
			agentId,
			filename: `shot.${mime.split('/')[1]}`,
			mime,
			bytes: bytes.length,
			now: ctx.now()
		});
		await ingest(settings, {
			db: ctx.db,
			token: created.token,
			body: bodyOf(bytes),
			now: ctx.now()
		});
		const outcome = await processMedia(settings, { db: ctx.db, id: created.mediaId, bus: ctx.bus });
		expect(outcome.status, JSON.stringify(outcome)).toBe('ready');
		return created.mediaId;
	}

	it('serves both thumbnails as webp — the addresses that 404 before the pipeline runs', async () => {
		const id = await derived(await exifImageBytes({ width: 1800, height: 900 }), 'image/png');

		for (const variant of ['thumb-640', 'thumb-1600']) {
			const response = await get(id, variant);

			expect(response.status, variant).toBe(200);
			expect(response.headers.get('content-type'), variant).toBe('image/webp');
			expect(response.headers.get('x-content-type-options'), variant).toBe('nosniff');
			expect(Number(response.headers.get('content-length'))).toBeGreaterThan(0);
			expect((await response.arrayBuffer()).byteLength).toBe(
				Number(response.headers.get('content-length'))
			);
		}
	});

	it('serves a video poster frame as jpeg', async () => {
		const id = await derived(await sampleVideoBytes({ seconds: 1 }), 'video/mp4');

		const response = await get(id, 'poster');

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('image/jpeg');
		expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
	});
});
