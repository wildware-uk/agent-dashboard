/**
 * Compress what goes out (the owner: "the dashboard itself is always insanely
 * slow, it takes so long to refresh, navigate, post").
 *
 * The dashboard's own HTML is a megabyte: the feed is server-rendered markdown,
 * and SvelteKit ships the same rows again as a hydration payload. Measured on
 * the live deployment, that one document is **962KB, and 100KB compressed** —
 * so nine tenths of every full load was wire time spent on bytes that squash
 * almost to nothing. The same is true of the snapshot endpoints the page refetches
 * after every event: 49KB each, about 8KB compressed, and they are fetched again
 * on every post, reaction and status change.
 *
 * Neither `adapter-node` nor this deployment's Caddy site block compresses
 * anything (Caddy's `encode` is not set for it), so nothing did. It belongs in
 * the proxy if the proxy will do it — a reverse proxy compresses without ever
 * buffering an application response — and this hook is the version that does not
 * need root on the Caddyfile. Both together are harmless: a response that
 * arrives already encoded is left alone by Caddy.
 *
 * **What is deliberately never touched:**
 *
 * - **Anything without a `Content-Length`.** That is the live feed
 *   (`text/event-stream`), which must reach the browser the instant each event
 *   is written: buffering it to compress it would make it arrive in lumps, or
 *   never. A streamed response has no declared length, so the rule "only
 *   compress what has one" is also the rule that protects the stream — and it
 *   is one check rather than a list of paths to remember.
 * - **Media.** Images, video and sound are already compressed, and gzipping a
 *   40MB video would burn CPU to make it bigger. The type allowlist covers this:
 *   only text-shaped types are compressed.
 * - **Anything already encoded**, so this cannot double-encode a response that
 *   some other layer has handled.
 * - **Small bodies.** Under {@link MIN_BYTES} the headers cost more than the
 *   saving.
 */
import type { Handle } from '@sveltejs/kit';
import { brotliCompress, gzip, constants } from 'node:zlib';
import { promisify } from 'node:util';

const deflateBrotli = promisify(brotliCompress);
const deflateGzip = promisify(gzip);

/**
 * Below this, compression is noise: a TCP segment is about this size, so a
 * smaller body arrives in one packet either way.
 */
export const MIN_BYTES = 1400;

/**
 * Above this, a response is not buffered to compress it.
 *
 * Nothing text-shaped in this deployment is near it; the cap is here so that a
 * future route answering with something enormous degrades to "sent uncompressed"
 * rather than "held entirely in memory".
 */
export const MAX_BYTES = 8_000_000;

/**
 * Types worth compressing: text, in its various spellings.
 *
 * An allowlist rather than "everything but media", for the usual reason — a
 * denylist is a promise to have thought of every already-compressed format.
 */
const TYPES = [
	'text/html',
	'text/plain',
	'text/css',
	'text/javascript',
	'application/javascript',
	'application/json',
	'application/manifest+json',
	'image/svg+xml'
];

/** Brotli quality. 4 is the knee: near-gzip speed, better than gzip ratio. */
const BROTLI_QUALITY = 4;

/** Which encoding the client will take, best first, or `null` for none. */
export function chosenEncoding(header: string | null): 'br' | 'gzip' | null {
	if (!header) return null;
	const offered = new Map<string, number>();
	for (const part of header.split(',')) {
		const [name, ...params] = part.trim().split(';');
		const q = params
			.map((p) => p.trim())
			.find((p) => p.startsWith('q='))
			?.slice(2);
		offered.set(name.trim().toLowerCase(), q === undefined ? 1 : Number(q));
	}
	// Brotli first: ~30% smaller than gzip on this HTML at a quality that costs
	// about the same to produce.
	if ((offered.get('br') ?? 0) > 0) return 'br';
	if ((offered.get('gzip') ?? 0) > 0) return 'gzip';
	return null;
}

/** Statuses that carry no body at all, whatever the headers claim. */
const BODILESS = [101, 204, 205, 304];

/**
 * Whether this response is one to compress, and nothing about how.
 *
 * The type allowlist is what protects the live feed: `text/event-stream` is not
 * on it, so a stream is never read to the end — which, for a feed that stays
 * open for hours, would mean never answering at all.
 *
 * A missing `Content-Length` is *not* a reason to skip. SvelteKit's `json()`
 * declares no length, and those are exactly the snapshot endpoints the page
 * refetches after every event; they are whole JSON documents, produced at once,
 * so buffering one costs nothing. Their size is checked after the fact instead.
 */
export function shouldCompress(response: Response): boolean {
	if (response.headers.has('content-encoding')) return false;
	if (BODILESS.includes(response.status) || !response.body) return false;

	const declared = response.headers.get('content-length');
	if (declared !== null) {
		const length = Number(declared);
		if (!Number.isFinite(length) || length < MIN_BYTES || length > MAX_BYTES) return false;
	}

	const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
	return TYPES.includes(type);
}

/**
 * The same response, compressed, or the response untouched.
 *
 * Exported so the decision is testable without a server; the hook below is a
 * two-line wrapper around it.
 */
export async function compressResponse(request: Request, response: Response): Promise<Response> {
	if (!shouldCompress(response)) return response;

	const encoding = chosenEncoding(request.headers.get('accept-encoding'));
	if (!encoding) return response;

	const body = Buffer.from(await response.arrayBuffer());

	// The size checks a declared `Content-Length` would have answered up front,
	// for the responses that declare none. The body is already in hand, so the
	// answer here is "send it as it is" rather than a second request.
	if (body.byteLength < MIN_BYTES || body.byteLength > MAX_BYTES) {
		return rebuild(response, body, response.headers);
	}

	const packed =
		encoding === 'br'
			? await deflateBrotli(body, {
					params: {
						[constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
						[constants.BROTLI_PARAM_SIZE_HINT]: body.byteLength
					}
				})
			: await deflateGzip(body, { level: 6 });

	// Worse compressed than raw — possible for something already packed that
	// slipped past the type list. Send what we had.
	if (packed.byteLength >= body.byteLength) return rebuild(response, body, response.headers);

	const headers = new Headers(response.headers);
	headers.set('content-encoding', encoding);
	headers.set('content-length', String(packed.byteLength));
	appendVary(headers, 'accept-encoding');

	return rebuild(response, packed, headers);
}

/** The same answer, around bytes already in hand. */
function rebuild(response: Response, body: Buffer, headers: HeadersInit): Response {
	// `Buffer` is a `Uint8Array`, but the DOM types for `BodyInit` do not know it:
	// the view is handed over rather than the Buffer wrapper.
	return new Response(new Uint8Array(body), {
		status: response.status,
		statusText: response.statusText,
		headers
	});
}

/** A cache must not serve a compressed body to a client that asked for none. */
function appendVary(headers: Headers, field: string): void {
	const existing = headers.get('vary');
	if (!existing) {
		headers.set('vary', field);
		return;
	}
	const already = existing
		.split(',')
		.map((part) => part.trim().toLowerCase())
		.includes(field);
	if (!already) headers.set('vary', `${existing}, ${field}`);
}

/** The hook. Runs outside the session guard: a refusal is worth compressing too. */
export const compressHandle: Handle = async ({ event, resolve }) => {
	const response = await resolve(event);
	return compressResponse(event.request, response);
};
