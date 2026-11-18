/**
 * `GET /api/stream`: the one live pipe to the browser (design §4).
 *
 * One SSE connection carries every event type, each frame tagged with the global
 * event sequence as its `id:`. That is the whole reconnect story: the browser
 * replays `Last-Event-ID` back at us, we serve the gap out of the ring buffer,
 * and when the gap is wider than the buffer we say `resync` once and let the
 * client refetch a snapshot instead of pretending we can fill it.
 *
 * Every `id:` is `<boot>-<seq>` (see `streamId` in `./frames.ts`), and every
 * connection opens with a `hello` frame naming the boot. The seq restarts at 1
 * with the process, so a cursor from another boot is told `resync` however
 * small its seq; a bare `<seq>` cursor, as clients sent before boot ids, is
 * still taken to mean this boot.
 *
 * The connection lifecycle lives here; the bytes live in `./frames.ts`. Nothing
 * in this file decides *what* is worth publishing — it subscribes to the bus and
 * serialises. That is why an SSE bug can never become a business-rule bug.
 */
import { EventBus, bus as sharedBus, type AppEvent, type Unsubscribe } from '$events';
import { bearerToken, type AuthConfig, type SessionCookieReader } from '../auth';
import {
	SSE_HEADERS,
	commentFrame,
	eventFrame,
	helloFrame,
	resyncFrame,
	retryFrame,
	type Resync
} from './frames';
import {
	environmentDevices,
	ownerAuthenticated,
	unauthenticatedResponse,
	type DeviceResolver
} from './owner';

/**
 * How often a comment frame goes out.
 *
 * Fifteen seconds is comfortably inside the idle timeouts that proxies and
 * mobile networks apply (nginx's `proxy_read_timeout` defaults to 60s), and is
 * cheap: two dozen bytes per client per beat.
 */
export const HEARTBEAT_MS = 15_000;

/**
 * How often a stream opened with a key checks that the key still works.
 *
 * Auth is otherwise checked once, at connect, and a stream is held open for
 * hours. Revoking a phone's device key or an agent's token has to cut the
 * stream it already holds, and the revocation may come from another process
 * (the CLI), so this asks the database again rather than waiting to be told.
 */
export const AUTH_CHECK_MS = 5_000;

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
	/** Which of the owner's phones holds a key. Injectable so tests need no database. */
	devices?: DeviceResolver;
	/** Milliseconds between comment frames. `0` disables the heartbeat. */
	heartbeatMs?: number;
	/** The `retry:` hint sent when the connection opens. */
	retryMs?: number;
	/** Milliseconds between checks that a device key still works. `0` disables them. */
	authCheckMs?: number;
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
	const {
		bus = sharedBus,
		config,
		devices = environmentDevices,
		heartbeatMs = HEARTBEAT_MS,
		retryMs = RETRY_MS,
		authCheckMs = AUTH_CHECK_MS
	} = options;

	return (event) => {
		if (!ownerAuthenticated(event, config, devices)) return unauthenticatedResponse();
		// A cookie session has nothing to revoke; a phone's device key does.
		const key = bearerToken(event.request.headers);

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
				let authCheck: ReturnType<typeof setInterval> | undefined;

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
					if (authCheck !== undefined) clearInterval(authCheck);
					event.request.signal?.removeEventListener('abort', teardown);
					try {
						controller.close();
					} catch {
						// Already closed or cancelled by the consumer. Idempotent by design:
						// abort and cancel both land here, and either may arrive first.
					}
				};

				// Replay, then subscribe, with no `await` between: `publish` is
				// synchronous, so no event can be published in this window. Subscribing
				// first would double-deliver the tail of the replay instead.
				const gap = cursor === null ? null : plan(bus, cursor);

				// A reconnect hint plus a comment: the comment is what forces a proxy
				// to flush its response headers, so the browser's `EventSource` fires
				// `onopen` immediately rather than when the first event happens to
				// arrive — which, on a quiet dashboard, could be hours. Then `hello`,
				// whose `id:` is where the client stands in this boot: its own cursor
				// when it is replayed from, the newest seq otherwise.
				const standing = gap && !('resync' in gap) ? gap.from : bus.lastSeq;
				write(
					`${retryFrame(retryMs)}${commentFrame('connected')}` +
						helloFrame({ boot: bus.boot, seq: standing })
				);

				if (gap) {
					if ('resync' in gap) write(resyncFrame(gap.resync));
					else for (const missed of gap.events) write(eventFrame(missed, bus.boot));
				}
				unsubscribe = bus.subscribe((published: AppEvent) =>
					write(eventFrame(published, bus.boot))
				);

				if (heartbeatMs > 0) {
					heartbeat = setInterval(
						() => write(commentFrame(`heartbeat ${new Date().toISOString()}`)),
						heartbeatMs
					);
					// Don't hold the process open for a client that is idling: a shutdown
					// should not have to wait out a heartbeat.
					heartbeat.unref?.();
				}

				if (key !== null && authCheckMs > 0) {
					// Revoked: end the stream. The client's reconnect then gets the 401
					// that tells it to sign in again.
					authCheck = setInterval(() => {
						try {
							if (devices(key) === null) teardown();
						} catch {
							// A read that fails is not a revocation; the next check asks again.
						}
					}, authCheckMs);
					authCheck.unref?.();
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

/** A client's cursor: the seq it last saw, and the boot it saw it in (`null` for a bare seq). */
export type StreamCursor = { boot: string | null; seq: number };

/** What a reconnecting client is owed: the events it missed, or one `resync`. */
type Gap = { from: number; events: readonly AppEvent[] } | { resync: Resync };

/**
 * Work out the client's gap, or that it cannot be served.
 *
 * A hit with no events (an up-to-date client) and a miss are deliberately
 * different results in `$events`: replaying a partial gap would hand the browser
 * a hole it would render as truth. A cursor from another boot is a miss whatever
 * its seq, because this process's seqs are not the ones the client counted.
 */
function plan(bus: EventBus, cursor: StreamCursor): Gap {
	const resync = (reason: Resync['reason']): Gap => ({
		resync: { reason, from: cursor.seq, seq: bus.lastSeq, boot: bus.boot }
	});
	if (cursor.boot !== null && cursor.boot !== bus.boot) return resync('restarted');
	const result = bus.replaySince(cursor.seq);
	return result.hit ? { from: cursor.seq, events: result.events } : resync(result.reason);
}

/**
 * The cursor this client last saw, or `null` for a fresh connection.
 *
 * `<boot>-<seq>` is what this server sends; a bare `<seq>` is what it sent
 * before boot ids, and is still read as a seq in this boot. Anything else is
 * treated as absent rather than as an error: a garbled cursor should cost the
 * client the replay, not the connection.
 */
export function readCursor({ request, url }: StreamRequestEvent): StreamCursor | null {
	const header = request.headers.get(LAST_EVENT_ID_HEADER);
	return parseCursor(header) ?? parseCursor(url.searchParams.get(LAST_EVENT_ID_PARAM));
}

function parseCursor(raw: string | null): StreamCursor | null {
	if (raw === null) return null;
	const match = /^(?:([0-9a-z]{1,32})-)?(\d+)$/.exec(raw.trim());
	if (!match) return null;
	const seq = Number(match[2]);
	return Number.isSafeInteger(seq) ? { boot: match[1] ?? null, seq } : null;
}
