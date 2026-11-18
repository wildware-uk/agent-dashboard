import { describe, expect, it } from 'vitest';
import { gunzipSync, brotliDecompressSync } from 'node:zlib';
import { chosenEncoding, compressResponse, MIN_BYTES, shouldCompress } from './compress';

/**
 * Compressing what goes out (the owner: "the dashboard itself is always insanely
 * slow, it takes so long to refresh, navigate, post").
 *
 * The rules that matter are the exclusions: the live feed must never be
 * buffered, and media must never be re-compressed.
 */
const prose = 'the feed is server-rendered markdown. '.repeat(200);

function answer(body: string, type = 'text/html', headers: Record<string, string> = {}): Response {
	return new Response(body, {
		headers: {
			'content-type': type,
			'content-length': String(Buffer.byteLength(body)),
			...headers
		}
	});
}

const asks = (accept: string | null) =>
	new Request(
		'http://dash.test/',
		accept === null ? {} : { headers: { 'accept-encoding': accept } }
	);

describe('what a client will take', () => {
	it('prefers brotli, falls back to gzip, and takes no for an answer', () => {
		expect(chosenEncoding('gzip, deflate, br, zstd')).toBe('br');
		expect(chosenEncoding('gzip, deflate')).toBe('gzip');
		expect(chosenEncoding('identity')).toBe(null);
		expect(chosenEncoding(null)).toBe(null);
	});

	it('honours a q of zero: offered is not the same as wanted', () => {
		expect(chosenEncoding('br;q=0, gzip')).toBe('gzip');
		expect(chosenEncoding('br;q=0, gzip;q=0')).toBe(null);
	});
});

describe('what gets compressed', () => {
	it('compresses the page, and it really is smaller', async () => {
		const response = await compressResponse(asks('br'), answer(prose));

		expect(response.headers.get('content-encoding')).toBe('br');
		expect(response.headers.get('vary')).toContain('accept-encoding');

		const packed = Buffer.from(await response.arrayBuffer());
		expect(packed.byteLength).toBeLessThan(Buffer.byteLength(prose) / 4);
		expect(brotliDecompressSync(packed).toString()).toBe(prose);
		// The length has to describe the bytes actually sent, or the client waits
		// for ones that never come.
		expect(Number(response.headers.get('content-length'))).toBe(packed.byteLength);
	});

	it('gzips for a client that cannot do brotli', async () => {
		const response = await compressResponse(asks('gzip, deflate'), answer(prose));

		expect(response.headers.get('content-encoding')).toBe('gzip');
		expect(gunzipSync(Buffer.from(await response.arrayBuffer())).toString()).toBe(prose);
	});

	it('compresses the snapshot endpoints the page refetches after every event', () => {
		expect(shouldCompress(answer(prose, 'application/json'))).toBe(true);
	});

	it('compresses a response that declares no length: SvelteKit json() declares none', async () => {
		// This is the real shape of /api/snapshot/updates — 49KB of JSON, refetched
		// after every event, and skipped entirely while the rule was "only what has
		// a Content-Length".
		const streamed = new Response(JSON.stringify({ prose }), {
			headers: { 'content-type': 'application/json; charset=utf-8' }
		});

		const response = await compressResponse(asks('br'), streamed);

		expect(response.headers.get('content-encoding')).toBe('br');
		expect(
			JSON.parse(brotliDecompressSync(Buffer.from(await response.arrayBuffer())).toString())
		).toEqual({ prose });
	});

	it('sends a short length-less body as it is', async () => {
		const small = new Response('{"ok":true}', {
			headers: { 'content-type': 'application/json' }
		});

		const response = await compressResponse(asks('br'), small);

		expect(response.headers.get('content-encoding')).toBe(null);
		expect(await response.text()).toBe('{"ok":true}');
	});

	it('leaves the body alone when nothing is accepted', async () => {
		const response = await compressResponse(asks(null), answer(prose));

		expect(response.headers.get('content-encoding')).toBe(null);
		expect(await response.text()).toBe(prose);
	});
});

describe('what is never touched', () => {
	it('never buffers a response with no declared length — that is the live feed', () => {
		const stream = new Response(
			new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode('event: ping\n\n'));
				}
			}),
			{ headers: { 'content-type': 'text/event-stream' } }
		);

		expect(shouldCompress(stream)).toBe(false);
	});

	it('never reads a response that has no body', () => {
		expect(shouldCompress(new Response(null, { status: 304 }))).toBe(false);
		expect(
			shouldCompress(new Response(null, { status: 204, headers: { 'content-type': 'text/html' } }))
		).toBe(false);
	});

	it('never compresses media: already packed, and big', () => {
		expect(shouldCompress(answer(prose, 'image/png'))).toBe(false);
		expect(shouldCompress(answer(prose, 'video/mp4'))).toBe(false);
		expect(shouldCompress(answer(prose, 'application/octet-stream'))).toBe(false);
	});

	it('never double-encodes', () => {
		expect(shouldCompress(answer(prose, 'text/html', { 'content-encoding': 'gzip' }))).toBe(false);
	});

	it('leaves a small body alone: the headers would cost more than the saving', () => {
		expect(shouldCompress(answer('x'.repeat(MIN_BYTES - 1)))).toBe(false);
		expect(shouldCompress(answer('x'.repeat(MIN_BYTES)))).toBe(true);
	});

	it('leaves something enormous alone rather than holding it in memory', () => {
		const huge = new Response(null, {
			headers: { 'content-type': 'text/html', 'content-length': String(9_000_000) }
		});

		expect(shouldCompress(huge)).toBe(false);
	});

	it('keeps the status and the other headers', async () => {
		const refused = new Response(prose, {
			status: 404,
			statusText: 'Not Found',
			headers: {
				'content-type': 'text/html',
				'content-length': String(Buffer.byteLength(prose)),
				'cache-control': 'no-store',
				vary: 'cookie'
			}
		});

		const response = await compressResponse(asks('br'), refused);

		expect(response.status).toBe(404);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(response.headers.get('vary')).toBe('cookie, accept-encoding');
	});

	it('round-trips what it sends, even when there is nothing to find', async () => {
		// Random printable text: brotli has little to work with, so this is the
		// case where compressing is close to pointless. Whatever it decides, the
		// bytes must still decode to what went in.
		const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
		let noise = '';
		for (let i = 0; i < 4096; i++) noise += alphabet[(i * 2654435761) % alphabet.length];

		const response = await compressResponse(asks('br'), answer(noise, 'text/plain'));

		const bytes = Buffer.from(await response.arrayBuffer());
		const back =
			response.headers.get('content-encoding') === 'br'
				? brotliDecompressSync(bytes).toString()
				: bytes.toString();
		expect(back).toBe(noise);
	});
});
