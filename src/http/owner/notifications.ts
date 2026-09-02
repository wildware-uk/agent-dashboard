/**
 * The owner's notification list (migration 021).
 *
 * `GET /api/notifications` is what the bell reads; `POST /api/notifications/seen`
 * is what clears it. Both are the owner's alone — the session is checked here as
 * well as in the hook, like every other write in `../owner/`.
 *
 * The list is read rather than derived: a notification is a row now, so what the
 * app shows is exactly what was recorded when the thing happened, including
 * things whose push was never delivered. That is the whole point of the feature.
 */
import { countUnseen, listNotifications, markSeen } from '$domain';
import { bus as sharedBus, type EventBus } from '$events';
import {
	ownerAction,
	readOwnerJson,
	type OwnerActionEvent,
	type OwnerHandler,
	type OwnerHandlerOptions
} from './actions';

export type { OwnerActionEvent, OwnerHandler };

export type NotificationHandlerOptions = OwnerHandlerOptions & {
	/** The bus whose cursor stamps the read, so a browser can drop old frames. */
	bus?: EventBus;
};

/** How many rows one read hands over, however large a limit is asked for. */
export const MAX_NOTIFICATIONS = 100;

/**
 * `GET /api/notifications` — newest first, with the unseen count.
 *
 * Stamped with the stream cursor read *before* the rows, for the reason
 * `../stream/snapshot.ts` gives: `seq` has to mean "this accounts for
 * everything up to here", or a notification published mid-read is dismissed as
 * already-included and the bell sits stale until the next reconnect.
 */
export function listNotificationsHandler(options: NotificationHandlerOptions = {}): OwnerHandler {
	const bus = options.bus ?? sharedBus;

	return ownerAction(options, (event, ctx) => {
		const seq = bus.lastSeq;
		const url = new URL(event.request.url);
		const unseenOnly = url.searchParams.get('unseen') === 'true';
		const asked = Number(url.searchParams.get('limit') ?? '');
		const limit = Number.isInteger(asked) && asked > 0 ? Math.min(asked, MAX_NOTIFICATIONS) : 50;

		return Promise.resolve({
			status: 200,
			body: {
				seq,
				at: new Date().toISOString(),
				notifications: listNotifications(ctx, { unseenOnly, limit }),
				unseen: countUnseen(ctx)
			}
		});
	});
}

/**
 * `POST /api/notifications/seen` — clear the bell.
 *
 * With `{ ids }`, only those: clicking one notification clears that one, which
 * is what a reader expects and what stops opening a single reply from wiping a
 * list they had not read. With no body, everything — "mark all read".
 */
export function markNotificationsSeenHandler(
	options: NotificationHandlerOptions = {}
): OwnerHandler {
	return ownerAction(options, async (event, ctx) => {
		const body = (await readOwnerJson(event.request).catch(() => ({}))) as {
			ids?: unknown;
		};
		const ids = Array.isArray(body.ids)
			? body.ids.filter((id): id is string => typeof id === 'string')
			: undefined;

		const changed = markSeen(ctx, ids);
		return { status: 200, body: { changed, unseen: countUnseen(ctx) } };
	});
}
