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

/** The event name of the frame that opens every connection with the boot id. */
export const HELLO_EVENT = 'hello';

/**
 * Why a resync was sent: the ring could not serve the cursor (`expired`,
 * `ahead`), or the cursor names another boot of the server (`restarted`).
 */
export type ResyncReason = ReplayMiss | 'restarted';

/**
 * The SSE `id:` of a frame: `<boot>-<seq>`.
 *
 * The seq alone restarts at 1 with the process, so a client holding seq 5 from
 * the last process could not be told apart from one at seq 5 in this one. With
 * the boot in front, the cursor a client sends back says which process it came
 * from. The browser's `EventSource` sends it back on its own as `Last-Event-ID`.
 */
export function streamId(boot: string, seq: number): string {
	return `${boot}-${seq}`;
}

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
	/** Why the replay failed. See {@link ResyncReason}. */
	reason: ResyncReason;
	/** The seq of the `Last-Event-ID` that could not be served. */
	from: number;
	/** The newest seq at the moment of the miss: where the client resumes from. */
	seq: number;
	/** This server's boot id. Left out only by callers that predate boot ids. */
	boot?: string;
};

/** What a `hello` frame tells the client: which boot it is talking to, and where it stands. */
export type Hello = {
	boot: string;
	/** The seq the client is resuming from in this boot (the newest one if it gave no cursor). */
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
export function eventFrame(event: AppEvent, boot?: string): string {
	const id = boot === undefined ? String(event.seq) : streamId(boot, event.seq);
	return `id: ${id}\nevent: ${event.type}\ndata: ${json(event)}\n\n`;
}

/**
 * The frame every connection opens with, after the preamble and before any
 * replay.
 *
 * Its `id:` is what makes the boot id stick even on a connection that never
 * sees an event: `EventSource` adopts it as `Last-Event-ID`, so a reconnect
 * after a restart names the old boot and is told `resync`. Clients that do not
 * know the event name ignore it.
 */
export function helloFrame(hello: Hello): string {
	const data = json({ type: HELLO_EVENT, boot: hello.boot, seq: hello.seq });
	return `id: ${streamId(hello.boot, hello.seq)}\nevent: ${HELLO_EVENT}\ndata: ${data}\n\n`;
}

/**
 * The single frame sent when the ring buffer cannot cover the client's gap.
 *
 * It carries an `id:` of the current newest seq (with the boot id) so that the client's next
 * reconnect resumes from the miss rather than asking for the same dead cursor
 * again. While nothing has ever been published there is no seq to quote, and
 * inventing `id: 0` would be a cursor the server never issued.
 */
export function resyncFrame(resync: Resync): string {
	// With a boot id, `<boot>-0` is a real cursor ("nothing yet in this boot"),
	// and sending it matters: without an `id:` the client keeps the dead cursor.
	const id =
		resync.boot !== undefined
			? `id: ${streamId(resync.boot, resync.seq)}\n`
			: resync.seq > 0
				? `id: ${resync.seq}\n`
				: '';
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
