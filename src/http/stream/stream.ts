/**
 * `GET /api/stream`: the one live pipe to the browser (design §4).
 *
 * One SSE connection carries every event type, each frame tagged with the global
 * event sequence as its `id:`. That is the whole reconnect story: the browser
 * replays `Last-Event-ID` back at us, we serve the gap out of the ring buffer,
 * and when the gap is wider than the buffer we say `resync` once and let the
 * client refetch a snapshot instead of pretending we can fill it.
 *
 * The connection lifecycle lives here; the bytes live in `./frames.ts`. Nothing
 * in this file decides *what* is worth publishing — it subscribes to the bus and
 * serialises. That is why an SSE bug can never become a business-rule bug.
 */
import { EventBus, bus as sharedBus, type AppEvent, type Unsubscribe } from '$events';
import type { AuthConfig, SessionCookieReader } from '../auth';
import { SSE_HEADERS, commentFrame, eventFrame, resyncFrame, retryFrame } from './frames';
import { ownerAuthenticated, unauthenticatedResponse } from './owner';

/**
 * How often a comment frame goes out.
 *
 * Fifteen seconds is comfortably inside the idle timeouts that proxies and
 * mobile networks apply (nginx's `proxy_read_timeout` defaults to 60s), and is
 * cheap: two dozen bytes per client per beat.
 */
export const HEARTBEAT_MS = 15_000;

/** How long a dropped client waits before reconnecting, via the SSE `retry:` field. */
export const RETRY_MS = 2_000;

/** The header `EventSource` sends on reconnect, all by itself. */
export const LAST_EVENT_ID_HEADER = 'last-event-id';

/**
 * The query-string spelling of the same cursor.
 *
 * `EventSource` cannot set headers, so a client that has just handled a
 * `resync` — and therefore knows the exact seq its snapshot is good to — has no
 * way to say so except in the URL.
 */
export const LAST_EVENT_ID_PARAM = 'last_event_id';

/** The slice of SvelteKit's `RequestEvent` this route needs. */
export type StreamRequestEvent = {
	request: Request;
	url: URL;
	cookies: SessionCookieReader;
};

export type StreamHandlerOptions = {
	/** Defaults to the process-wide bus. Tests pass their own. */
	bus?: EventBus;
	/** Auth secrets, injectable so tests need no environment. */
	config?: () => AuthConfig | null;
	/** Milliseconds between comment frames. `0` disables the heartbeat. */
	heartbeatMs?: number;
	/** The `retry:` hint sent when the connection opens. */
	retryMs?: number;
};

export type StreamHandler = (event: StreamRequestEvent) => Response;

/**
 * Build the `GET` handler for the stream route.
 *
 * The returned function is synchronous on purpose: it must subscribe to the bus
 * in the same tick it computes the replay, or an event published in between
 * would fall down the gap between the two — seen by neither.
 */
export function createStreamHandler(options: StreamHandlerOptions = {}): StreamHandler {
	const { bus = sharedBus, config, heartbeatMs = HEARTBEAT_MS, retryMs = RETRY_MS } = options;

	return (event) => {
		if (!ownerAuthenticated(event, config)) return unauthenticatedResponse();

		const cursor = readCursor(event);
		const encoder = new TextEncoder();
		// Assigned in `start`, which a ReadableStream runs synchronously during
		// construction, so `cancel` can never see the placeholder.
		let teardown = () => {};

		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				let open = true;
				let unsubscribe: Unsubscribe = () => {};
				let heartbeat: ReturnType<typeof setInterval> | undefined;

				const write = (frame: string) => {
					if (!open) return;
					try {
						controller.enqueue(encoder.encode(frame));
					} catch {
						// The consumer went away between our last check and this write.
						// Nothing to report: dropping the client is the correct outcome.
						teardown();
					}
				};

				teardown = () => {
					if (!open) return;
					open = false;
					unsubscribe();
					if (heartbeat !== undefined) clearInterval(heartbeat);
					event.request.signal?.removeEventListener('abort', teardown);
					try {
						controller.close();
					} catch {
						// Already closed or cancelled by the consumer. Idempotent by design:
						// abort and cancel both land here, and either may arrive first.
					}
				};

				// A reconnect hint plus a comment: the comment is what forces a proxy
				// to flush its response headers, so the browser's `EventSource` fires
				// `onopen` immediately rather than when the first event happens to
				// arrive — which, on a quiet dashboard, could be hours.
				write(`${retryFrame(retryMs)}${commentFrame('connected')}`);

				// Replay, then subscribe, with no `await` between: `publish` is
				// synchronous, so no event can be published in this window. Subscribing
				// first would double-deliver the tail of the replay instead.
				if (cursor !== null) replay(bus, cursor, write);
				unsubscribe = bus.subscribe((published: AppEvent) => write(eventFrame(published)));

				if (heartbeatMs > 0) {
					heartbeat = setInterval(
						() => write(commentFrame(`heartbeat ${new Date().toISOString()}`)),
						heartbeatMs
					);
					// Don't hold the process open for a client that is idling: a shutdown
					// should not have to wait out a heartbeat.
					heartbeat.unref?.();
				}

				const signal = event.request.signal;
				// `abort` fires when the client goes away mid-request; `cancel` fires
				// when the consumer drops the body. Whichever comes first wins, and the
				// other is a no-op.
				signal?.addEventListener('abort', teardown, { once: true });
				// An already-aborted request never fires the listener above.
				if (signal?.aborted) teardown();
			},
			cancel() {
				teardown();
			}
		});

		return new Response(body, { status: 200, headers: { ...SSE_HEADERS } });
	};
}

/**
 * Serve the client's gap, or tell it once that we cannot.
 *
 * A hit with no events (an up-to-date client) and a miss are deliberately
 * different results in `$events`: replaying a partial gap would hand the browser
 * a hole it would render as truth.
 */
function replay(bus: EventBus, cursor: number, write: (frame: string) => void): void {
	const result = bus.replaySince(cursor);
	if (result.hit) {
		for (const missed of result.events) write(eventFrame(missed));
		return;
	}
	write(resyncFrame({ reason: result.reason, from: cursor, seq: bus.lastSeq }));
}

/**
 * The sequence number this client last saw, or `null` for a fresh connection.
 *
 * Anything that is not a non-negative integer is treated as absent rather than
 * as an error: a garbled cursor should cost the client the replay, not the
 * connection.
 */
export function readCursor({ request, url }: StreamRequestEvent): number | null {
	const header = request.headers.get(LAST_EVENT_ID_HEADER);
	return parseCursor(header) ?? parseCursor(url.searchParams.get(LAST_EVENT_ID_PARAM));
}

function parseCursor(raw: string | null): number | null {
	if (raw === null) return null;
	const trimmed = raw.trim();
	if (!/^\d+$/.test(trimmed)) return null;
	const seq = Number(trimmed);
	return Number.isSafeInteger(seq) ? seq : null;
}
