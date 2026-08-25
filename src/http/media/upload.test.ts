import { findMediaById } from '$db';
import { harness, type Harness } from '$domain/testing';
import { createUpload as mintUpload } from '$media';
import { pngBytes, paddedBytes, tempSettings, zipBytes } from '$media/testing';
import { createTokenRateLimiter } from '$mcp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createUploadHandler, type UploadHandlerOptions } from './upload';

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

/** A reservation made at a chosen moment, so expiry can be exercised. */
function reserve(options: { mime?: string; bytes?: number; now?: number } = {}) {
	return mintUpload(settings, {
		db: ctx.db,
		agentId,
		filename: 'shot.png',
		mime: options.mime ?? 'image/png',
		bytes: options.bytes ?? pngBytes().length,
		now: options.now ?? ctx.now()
	});
}

async function put(
	token: string,
	body: BodyInit | null,
	options: UploadHandlerOptions & { contentLength?: string } = {}
) {
	const handler = createUploadHandler({
		context: options.context ?? (() => ctx),
		settings: options.settings ?? (() => settings),
		rateLimiter: options.rateLimiter
	});
	const headers = options.contentLength ? { 'content-length': options.contentLength } : undefined;
	const response = await handler({
		request: new Request(`https://dash.test/api/upload/${token}`, {
			method: 'PUT',
			body,
			headers
		}),
		params: { token }
	});

	return { response, body: await response.json() };
}

const bytesOf = (source: Uint8Array) => new Uint8Array(source) as unknown as BodyInit;

describe('PUT /api/upload/:token', () => {
	it('takes the bytes and reports what was stored', async () => {
		const created = reserve();
		const png = pngBytes();

		const { response, body } = await put(created.token, bytesOf(png));

		expect(response.status).toBe(201);
		expect(body).toMatchObject({
			media_id: created.mediaId,
			bytes: png.length,
			mime: 'image/png',
			kind: 'image',
			status: 'pending',
			deduped: false
		});
		expect(findMediaById(ctx.db, created.mediaId)!.bytes).toBe(png.length);
	});

	it('tells the agent when its bytes were already on disk', async () => {
		const png = pngBytes();
		await put(reserve().token, bytesOf(png));

		const { body } = await put(reserve().token, bytesOf(png));

		expect(body.deduped).toBe(true);
	});

	it('never tells the caller where anything is on disk', async () => {
		const created = reserve();

		const { body } = await put(created.token, bytesOf(pngBytes()));

		expect(JSON.stringify(body)).not.toContain(settings.dataDir);
		expect(JSON.stringify(body)).not.toContain('original.png');
	});

	it('answers 415 for a zip renamed to .png', async () => {
		const created = reserve({ bytes: zipBytes().length });

		const { response, body } = await put(created.token, bytesOf(zipBytes()));

		expect(response.status).toBe(415);
		expect(body.error).toBe('unsupported_type');
		expect(body.message).toMatch(/application\/zip/);
	});

	it('answers 413 for a body past the cap', async () => {
		const created = reserve({ bytes: 1024 });

		const { response, body } = await put(created.token, bytesOf(paddedBytes(pngBytes(), 8192)));

		expect(response.status).toBe(413);
		expect(body.error).toBe('too_large');
	});

	it('answers 413 on a lying Content-Length without reading the body', async () => {
		const created = reserve({ bytes: 1024 });

		const { response } = await put(created.token, bytesOf(pngBytes()), {
			contentLength: String(10 * 1024 * 1024)
		});

		expect(response.status).toBe(413);
	});

	it('answers 403 for a token that is spent, expired, or not ours', async () => {
		const created = reserve();
		await put(created.token, bytesOf(pngBytes()));

		const spent = await put(created.token, bytesOf(pngBytes()));
		const expired = await put(
			reserve({ now: ctx.now() - 16 * 60 * 1000 }).token,
			bytesOf(pngBytes())
		);
		const forged = await put('01K3ABCDEFGHJKMNPQRSTVWXYZ.notasignature', bytesOf(pngBytes()));
		const nonsense = await put('rubbish', bytesOf(pngBytes()));

		for (const attempt of [spent, expired, forged, nonsense]) {
			expect(attempt.response.status).toBe(403);
			expect(attempt.body.error).toBe('token_rejected');
		}
	});

	it('answers 400 for a PUT with no body', async () => {
		const { response, body } = await put(reserve().token, null);

		expect(response.status).toBe(400);
		expect(body.error).toBe('invalid_argument');
	});

	it('rate limits attempts on one token, so a loop cannot hammer the route', async () => {
		const created = reserve();
		const rateLimiter = createTokenRateLimiter({ limit: 2, windowMs: 60_000 });

		const first = await put(created.token, bytesOf(zipBytes()), { rateLimiter });
		const second = await put(created.token, bytesOf(zipBytes()), { rateLimiter });
		const third = await put(created.token, bytesOf(zipBytes()), { rateLimiter });

		// The first attempt spends the token, so the second is refused as a reused
		// one — and the third never gets that far, because retrying a dead token in
		// a loop is exactly what the limit is for.
		expect(first.response.status).toBe(415);
		expect(second.response.status).toBe(403);
		expect(third.response.status).toBe(429);
		expect(Number(third.response.headers.get('retry-after'))).toBeGreaterThan(0);
	});

	it('refuses to serve at all when the deployment is not configured', async () => {
		const { response, body } = await put('anything', bytesOf(pngBytes()), {
			settings: () => null
		});

		expect(response.status).toBe(503);
		expect(body.error).toBe('misconfigured');
	});

	it('says nothing on the event bus: the derivative pipeline is what announces media', async () => {
		await put(reserve().token, bytesOf(pngBytes()));

		expect(ctx.eventNames()).toEqual([]);
	});
});
