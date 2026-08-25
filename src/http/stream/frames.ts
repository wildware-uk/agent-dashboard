/**
 * The wire format of `GET /api/stream` (design §4).
 *
 * Pure string building, kept apart from the connection lifecycle so the bytes a
 * browser sees are pinned by tests that need no stream, no timers and no
 * request. Every frame ends with the blank line that terminates an SSE event;
 * forgetting it is the classic bug where a client receives nothing until the
 * connection closes.
 */
import type { AppEvent, ReplayMiss } from '$events';

/** The event name of the "your cursor is too old, refetch" signal (design §4). */
export const RESYNC_EVENT = 'resync';

/**
 * Response headers for the stream.
 *
 * `x-accel-buffering: no` is the per-response counterpart to nginx's
 * `proxy_buffering off`: nginx honours it, so a deployment that forgot the
 * directive still streams. It is a belt, not a replacement for the braces —
 * other proxies ignore it, which is why the requirement is documented at the
 * route and in the README.
 *
 * `no-transform` matters as much as `no-cache`: a proxy that gzips the stream
 * will buffer it to do so, and the symptom is a dashboard that updates in
 * bursts minutes late.
 */
export const SSE_HEADERS = {
	'content-type': 'text/event-stream; charset=utf-8',
	'cache-control': 'no-cache, no-store, no-transform',
	connection: 'keep-alive',
	'x-accel-buffering': 'no'
} as const;

/** What a `resync` frame tells the browser. */
export type Resync = {
	/** Why the replay failed: the cursor was `expired` or `ahead` of the buffer. */
	reason: ReplayMiss;
	/** The `Last-Event-ID` that could not be served. */
	from: number;
	/** The newest seq at the moment of the miss: where the client resumes from. */
	seq: number;
};

/**
 * One event as an SSE frame.
 *
 * `id:` is the global sequence number, which is exactly what the browser sends
 * back as `Last-Event-ID`, so replay needs no second cursor. The `data:` payload
 * is the whole envelope rather than just the payload, so a single `onmessage`
 * handler can switch on `type` without registering eleven listeners.
 */
export function eventFrame(event: AppEvent): string {
	return `id: ${event.seq}\nevent: ${event.type}\ndata: ${json(event)}\n\n`;
}

/**
 * The single frame sent when the ring buffer cannot cover the client's gap.
 *
 * It carries an `id:` of the current newest seq so that the client's next
 * reconnect resumes from the miss rather than asking for the same dead cursor
 * again. While nothing has ever been published there is no seq to quote, and
 * inventing `id: 0` would be a cursor the server never issued.
 */
export function resyncFrame(resync: Resync): string {
	const id = resync.seq > 0 ? `id: ${resync.seq}\n` : '';
	return `${id}event: ${RESYNC_EVENT}\ndata: ${json({ type: RESYNC_EVENT, ...resync })}\n\n`;
}

/**
 * A comment frame: bytes that keep the connection and any proxy in front of it
 * awake, and that every SSE client ignores.
 */
export function commentFrame(text: string): string {
	return `: ${collapse(text)}\n\n`;
}

/** Tell the client how long to wait before reconnecting after a drop. */
export function retryFrame(ms: number): string {
	return `retry: ${Math.max(0, Math.round(ms))}\n\n`;
}

/**
 * JSON with any line break flattened.
 *
 * `JSON.stringify` escapes `\n` inside strings, so this is belt and braces
 * against an exotic value: a raw newline in a `data:` line would split one event
 * into two malformed ones.
 */
function json(value: unknown): string {
	return collapse(JSON.stringify(value));
}

function collapse(text: string): string {
	return text.replace(/\r\n|[\r\n]/g, ' ');
}
