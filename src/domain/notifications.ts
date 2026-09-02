/**
 * Notifications the owner can read in the app (migration 021).
 *
 * Their ask, in their words: "all notifications should be accessible from
 * within the app, clicking a notification should take me to the relevant
 * message or reply."
 *
 * Both halves change what a notification *is* here. It used to be a push
 * message and nothing else — so a phone that was asleep, a permission never
 * granted, or a browser that dropped the payload meant the thing that happened
 * left no trace anybody could go back to. Now the same three events that send a
 * push write a row, and push becomes one *delivery* of a notification rather
 * than the notification itself.
 *
 * And a notification points somewhere. `path` is a route with the thing to
 * focus on in the query string, which is what makes a tap land on the reply
 * rather than at the top of a project with fifty cards under it.
 *
 * What is recorded is what the owner would be told about: an agent's update, an
 * agent's message, a request waiting on them. Never their own words — the owner
 * typing on their laptop must not light up their own bell — and never an event
 * with nothing behind it, because a notification that opens an empty card is
 * worse than one that never arrived.
 */
import {
	countUnseenNotifications,
	findAgentById,
	findApprovalById,
	findMessageById,
	findProjectById,
	findUpdateById,
	insertNotification,
	listNotifications as listNotificationRows,
	markNotificationsSeen,
	type Notification
} from '$db';
import { bus as sharedBus, type EventBus } from '$events';
import { context as sharedContext, type DomainContext } from './context';
import { HUMAN_AUTHOR, parseAuthor } from './messages';
import { repliesToOwner } from './push';

/** How many the bell lists at once. A list nobody scrolls is a list nobody reads. */
export const DEFAULT_NOTIFICATION_LIMIT = 50;

/** One notification, with everything the app needs to show it and open it. */
export type NotificationView = Notification & {
	/** The project's slug, for the label on the row. */
	projectSlug: string | null;
	projectName: string | null;
	/**
	 * Where clicking it goes.
	 *
	 * A route plus `focus`, which the timeline scrolls to and highlights. The
	 * whole point of the feature: a notification that lands on a project page is
	 * a notification that makes its owner go hunting.
	 */
	path: string;
};

/** The first line of something, for a row that has one line to say it in. */
function firstLine(body: string, max = 140): string {
	const flat = body.replace(/\s+/g, ' ').trim();
	return flat.length <= max ? flat : `${flat.slice(0, max).trimEnd()}…`;
}

/** Where one notification opens. */
function pathFor(notification: Notification, slug: string | null): string {
	const focus = notification.updateId ?? notification.messageId ?? notification.requestId;
	const base = slug ? `/projects/${slug}` : '/';
	return focus ? `${base}?focus=${encodeURIComponent(focus)}` : base;
}

/** Fill in what the app needs beyond the row itself. */
function view(ctx: DomainContext, notification: Notification): NotificationView {
	const project = notification.projectId ? findProjectById(ctx.db, notification.projectId) : null;
	return {
		...notification,
		projectSlug: project?.slug ?? null,
		projectName: project?.name ?? null,
		path: pathFor(notification, project?.slug ?? null)
	};
}

/** Newest first, as the bell reads them. */
export function listNotifications(
	ctx: DomainContext,
	query: { unseenOnly?: boolean; limit?: number } = {}
): NotificationView[] {
	return listNotificationRows(ctx.db, {
		unseenOnly: query.unseenOnly,
		limit: query.limit ?? DEFAULT_NOTIFICATION_LIMIT
	}).map((row) => view(ctx, row));
}

/** How many the owner has not looked at: the number on the bell. */
export function countUnseen(ctx: DomainContext): number {
	return countUnseenNotifications(ctx.db);
}

/**
 * Mark notifications seen, and say so.
 *
 * Announced because the count is on every open tab: a bell cleared on the desk
 * has to clear on the phone, which is the same rule `projects.owner_seen_at`
 * keeps (migration 011). Quiet when nothing changed — an event that says the
 * count is what it already was is noise every listener has to refetch for.
 */
export function markSeen(ctx: DomainContext, ids?: readonly string[]): number {
	const changed = markNotificationsSeen(ctx.db, { ids, at: ctx.now() });
	if (changed > 0) ctx.bus.publish('notifications.seen', { count: changed });
	return changed;
}

/**
 * Record one notification, if there is something to record.
 *
 * Idempotent per target, so a replayed event or two racing subscribers leave one
 * row: the count is what the owner reads as "how much is waiting", and it must
 * not double.
 */
export function recordNotification(
	ctx: DomainContext,
	input: {
		kind: 'update' | 'reply' | 'request';
		projectId?: string | null;
		updateId?: string | null;
		messageId?: string | null;
		requestId?: string | null;
		agentId?: string | null;
		title: string;
		body: string;
	}
): NotificationView | null {
	const { notification, created } = insertNotification(ctx.db, {
		...input,
		createdAt: ctx.now()
	});
	if (!created) return null;

	const full = view(ctx, notification);
	ctx.bus.publish('notification.created', {
		notificationId: full.id,
		kind: full.kind,
		projectId: full.projectId
	});
	return full;
}

/** What to record for one posted update, or `null` for one nobody should hear about. */
export function notificationForUpdate(
	ctx: DomainContext,
	updateId: string
): Parameters<typeof recordNotification>[1] | null {
	const update = findUpdateById(ctx.db, updateId);
	if (!update || update.deletedAt !== null) return null;

	const agent = findAgentById(ctx.db, update.agentId);
	const who = agent?.name ?? 'An agent';
	return {
		kind: 'update',
		projectId: update.projectId,
		updateId: update.id,
		agentId: update.agentId,
		title: update.title ?? `${who} posted an update`,
		body: firstLine(update.body)
	};
}

/** The same for a message. `null` for the owner's own, which is not news to them. */
export function notificationForMessage(
	ctx: DomainContext,
	messageId: string
): Parameters<typeof recordNotification>[1] | null {
	const message = findMessageById(ctx.db, messageId);
	if (!message || message.deletedAt !== null || message.author === HUMAN_AUTHOR) return null;

	const author = parseAuthor(message.author);
	if (!author || author.kind !== 'agent') return null;

	const agent = findAgentById(ctx.db, author.agentId);
	const who = agent?.name ?? 'An agent';
	// The same distinction the push filter makes: an answer aimed at the owner
	// reads differently from a note between agents, and the row says which.
	const answered = repliesToOwner(ctx, message);

	return {
		kind: 'reply',
		projectId: message.projectId,
		messageId: message.id,
		agentId: author.agentId,
		title: answered ? `${who} replied to you` : `${who} commented`,
		body: firstLine(message.body)
	};
}

/** And for a request, which is the one an owner most needs to find again. */
export function notificationForRequest(
	ctx: DomainContext,
	requestId: string
): Parameters<typeof recordNotification>[1] | null {
	const request = findApprovalById(ctx.db, requestId);
	if (!request) return null;

	const agent = findAgentById(ctx.db, request.agentId);
	const who = agent?.name ?? 'An agent';
	return {
		kind: 'request',
		projectId: request.projectId,
		requestId: request.id,
		agentId: request.agentId,
		title: `${who} is waiting on you`,
		body: firstLine(request.question)
	};
}

export type NotificationRecorderOptions = {
	context?: () => DomainContext;
	bus?: EventBus;
	onError?: (error: unknown) => void;
};

/**
 * Write a notification for everything the owner would be pushed.
 *
 * A bus subscriber rather than a call inside each write, for the reason every
 * other fan-out here is: the domain publishes once and whatever cares hangs off
 * it, so an agent's tool call never waits on this.
 *
 * @returns an unsubscribe, so a test can take it back off the bus.
 */
export function startNotificationRecorder(options: NotificationRecorderOptions = {}): () => void {
	const {
		context: getContext = sharedContext,
		bus = sharedBus,
		onError = (error: unknown) => console.error('recording a notification failed', error)
	} = options;

	return bus.subscribe((event) => {
		if (
			event.type !== 'update.created' &&
			event.type !== 'message.created' &&
			event.type !== 'request.created'
		) {
			return;
		}

		try {
			const ctx = getContext();
			const input =
				event.type === 'update.created'
					? notificationForUpdate(ctx, event.payload.updateId)
					: event.type === 'message.created'
						? notificationForMessage(ctx, event.payload.messageId)
						: notificationForRequest(ctx, event.payload.requestId);

			if (input) recordNotification(ctx, input);
		} catch (error) {
			// A notification that could not be written must never take down the write
			// it was about: the update, the reply and the request have all already
			// happened by the time this runs.
			onError(error);
		}
	});
}
