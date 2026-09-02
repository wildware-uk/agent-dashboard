/**
 * Web Push: reaching the owner when the dashboard is not open (design §5, §7).
 *
 * ## Why this exists at all
 *
 * Every other live region in this product assumes a tab. A request does not: an
 * agent that calls `request_input` has stopped dead, and the owner is the only
 * thing that can start it again — often while the dashboard is closed and the
 * phone is in a pocket. The SSE stream cannot reach there and neither can the
 * in-tab `Notification` API, so the one mechanism that does is a push service,
 * which means a subscription stored here and a payload signed with VAPID keys.
 *
 * ## What is deliberately not here
 *
 * **No queue and no retry schedule.** A push is a nudge, not the record: the
 * request itself is a row in `approvals` and the dashboard shows it whether or
 * not the notification ever arrived. So a send that fails is logged and counted,
 * never retried into a backlog that could deliver "an agent is waiting" an hour
 * after the agent stopped waiting.
 *
 * **No payload worth intercepting.** The notification carries the question and
 * the agent's name, because a notification that says "you have a notification"
 * is one nobody acts on — but nothing that is not already on the owner's screen,
 * and never an answer, a token or an id that grants anything.
 *
 * ## Subscriptions clean themselves up
 *
 * A push service answers `404` or `410` for a subscription that is gone — the
 * browser was uninstalled, the owner cleared site data, the endpoint expired.
 * That is definitive, so the row is deleted on the spot. Anything else is
 * treated as transient and counted, and a subscription that fails
 * {@link MAX_PUSH_FAILURES} times in a row is dropped too: an endpoint that has
 * refused ten notifications is not going to accept the eleventh, and keeping it
 * would slow every future send for a browser nobody is holding.
 */
import webpush, { type PushSubscription as WebPushSubscription } from 'web-push';
import {
	deletePushSubscription,
	findAgentById,
	findMessageById,
	findProjectById,
	findUpdateById,
	listPushSubscriptions,
	markPushFailed,
	markPushSent,
	setPushPrefs,
	upsertPushSubscription,
	listMessages,
	type Message,
	type PushPrefs,
	type PushSubscription,
	type UpdateLevel,
	type UpdatePriority
} from '$db';
import { bus as sharedBus, type EventBus } from '$events';
import { loadConfig, pushConfig, type PushConfig } from '$config';
import { context as sharedContext, type DomainContext } from './context';
import { invalid, notFound } from './errors';
import { findRequest, type OwnerRequest } from './requests';
import { UPDATE_LEVELS, UPDATE_PRIORITIES } from './updates';
import { HUMAN_AUTHOR, parseAuthor } from './messages';
import { optionalText } from './text';

/**
 * The kinds of thing a device can be notified about (design §7).
 *
 * Three, because they are three different interruptions. A `request` is an agent
 * stopped dead and unable to continue; an `update` is something that happened; a
 * `message` is an agent answering the owner. An owner who wants their phone for
 * the first and their laptop for all three is expressing a real preference, not
 * a fiddly one.
 */
export const PUSH_TYPES = ['request', 'update', 'message', 'comment'] as const;
export type PushType = (typeof PUSH_TYPES)[number];

/**
 * What every device is notified about until it says otherwise.
 *
 * All three, because "notify me" is what the owner asked for when they turned
 * the toggle on: a device that says nothing else has expressed no preference,
 * and a default that silently dropped two of the three kinds looked exactly
 * like push being broken — the owner turns notifications on, an agent posts an
 * error, and nothing arrives. Narrowing it is one panel away
 * (`src/web/NotifyToggle.svelte`) and is stored per device, so a phone that
 * only wants questions is still a phone that only wants questions.
 */
export const DEFAULT_PUSH_TYPES: readonly PushType[] = ['request', 'update', 'message', 'comment'];

/** What one notification is about, for a device's filter to judge. */
export type Notifiable = {
	type: PushType;
	/** Updates only: what kind of thing happened. */
	level?: UpdateLevel;
	/** Updates only: whether it can wait. */
	priority?: UpdatePriority;
};

/**
 * Whether this device wants to hear about this.
 *
 * Three independent whitelists, and an absent one means "no opinion, allow" on
 * every axis: a device that has never been configured hears about everything,
 * which is what the owner asked for when they turned notifications on.
 *
 * Level and priority are only consulted for updates. A request has no level and
 * no priority: an agent is stopped, and there is no severity at which that stops
 * being true.
 */
export function notifies(prefs: PushPrefs | null | undefined, about: Notifiable): boolean {
	const types = prefs?.types ?? DEFAULT_PUSH_TYPES;
	if (!types.includes(about.type)) return false;
	if (about.type !== 'update') return true;

	if (prefs?.levels && about.level && !prefs.levels.includes(about.level)) return false;
	if (prefs?.priorities && about.priority && !prefs.priorities.includes(about.priority)) {
		return false;
	}
	return true;
}

/**
 * A device's preferences, checked.
 *
 * Unknown members are refused rather than ignored: a filter that silently drops
 * the word it did not understand is a filter that quietly notifies about more
 * than the owner asked for, and they would only find out at 2am. `null` restores
 * the default.
 */
export function assertPushPrefs(input: unknown): PushPrefs | null {
	if (input === null || input === undefined) return null;
	if (typeof input !== 'object' || Array.isArray(input)) {
		throw invalid('preferences must be an object, or null for the default');
	}

	const body = input as Record<string, unknown>;
	const prefs: PushPrefs = {};

	const list = (value: unknown, field: string, allowed: readonly string[]): string[] => {
		if (!Array.isArray(value)) throw invalid(`${field} must be a list`);
		for (const member of value) {
			if (typeof member !== 'string' || !allowed.includes(member)) {
				throw invalid(`${field} must be any of: ${allowed.join(', ')}`);
			}
		}
		return [...new Set(value as string[])];
	};

	if (body.types !== undefined) prefs.types = list(body.types, 'types', PUSH_TYPES);
	if (body.levels !== undefined) prefs.levels = list(body.levels, 'levels', UPDATE_LEVELS);
	if (body.priorities !== undefined) {
		prefs.priorities = list(body.priorities, 'priorities', UPDATE_PRIORITIES);
	}

	return Object.keys(prefs).length === 0 ? null : prefs;
}

/** How many consecutive transient failures before a subscription is given up on. */
export const MAX_PUSH_FAILURES = 10;

/** Long enough for a user-agent string worth reading, short enough to be a label. */
export const PUSH_LABEL_MAX_LENGTH = 200;

/** What the browser hands over, as `PushSubscription.toJSON()` produces it. */
export type PushSubscriptionInput = {
	endpoint: string;
	keys: { p256dh: string; auth: string };
	/** What the browser is, so the owner can tell two of them apart. Optional. */
	label?: string | null;
};

/**
 * Store a browser's subscription.
 *
 * The endpoint must be `https:` — a push service is always one, and accepting
 * anything else would mean storing a URL this server will later POST to.
 *
 * @throws {DomainError} `invalid_argument` for a missing or non-https endpoint,
 *   or missing keys.
 */
export function subscribeToPush(
	ctx: DomainContext,
	input: PushSubscriptionInput
): PushSubscription {
	const endpoint = (input.endpoint ?? '').trim();
	if (endpoint === '') throw invalid('endpoint is required');

	let parsed: URL;
	try {
		parsed = new URL(endpoint);
	} catch {
		throw invalid('endpoint must be an absolute URL');
	}
	if (parsed.protocol !== 'https:') throw invalid('endpoint must be an https URL');

	const p256dh = (input.keys?.p256dh ?? '').trim();
	const auth = (input.keys?.auth ?? '').trim();
	if (p256dh === '' || auth === '') throw invalid('keys.p256dh and keys.auth are required');

	return upsertPushSubscription(ctx.db, {
		endpoint,
		p256dh,
		auth,
		label: optionalText(input.label, 'label', PUSH_LABEL_MAX_LENGTH),
		createdAt: ctx.now()
	});
}

/** Forget a subscription. Idempotent: unsubscribing twice is not an error. */
export function unsubscribeFromPush(ctx: DomainContext, endpoint: string): boolean {
	const trimmed = (endpoint ?? '').trim();
	if (trimmed === '') throw invalid('endpoint is required');
	return deletePushSubscription(ctx.db, trimmed);
}

/** Every subscription this deployment would send to. */
export function listPushSubscriptionsFor(ctx: DomainContext): PushSubscription[] {
	return listPushSubscriptions(ctx.db);
}

/** One notification, before it is encrypted for anybody in particular. */
/**
 * One button on the notification itself.
 *
 * `action` is the id the service worker is handed back in `notificationclick`,
 * and `value` is the answer to POST when it is — carried in the payload so the
 * worker never has to reconstruct what a label meant.
 */
export type PushAction = { action: string; title: string; value: string | boolean };

/**
 * How many actions to offer.
 *
 * Two, because that is what the browsers implementing them show; a third is
 * dropped silently, and an answer the owner can see but not reach is worse than
 * one never offered. Every other option is one tap further away, on the card.
 */
export const MAX_PUSH_ACTIONS = 2;

export type PushMessage = {
	title: string;
	body: string;
	/** Where tapping it should land. Absolute, because a service worker has no page. */
	url: string;
	/**
	 * Collapse key. Two notifications about the same request replace each other
	 * rather than stacking, which is what stops a reconnecting browser from
	 * showing the same blocked agent three times.
	 */
	tag: string;
	/**
	 * The request this is about, so the worker can answer it without opening a
	 * page. Absent when there is nothing to answer.
	 */
	requestId?: string;
	/**
	 * Buttons on the notification, for the kinds one tap can settle.
	 *
	 * Support is per-browser and this deliberately does not care: a browser that
	 * implements notification actions shows them on a long press, one that does
	 * not ignores the field and shows the plain notification. Tapping the body
	 * still opens the card either way, so nothing here is the only route to an
	 * answer — which is what makes it safe to send them to every browser and let
	 * each decide.
	 */
	actions?: PushAction[];
};

/** What one send did, so a caller can log it without re-deriving it. */
export type PushResult = { sent: number; removed: number; failed: number };

export type PushSettings = () => PushConfig | null;

/** Production reads the environment; a test hands over a keypair or `null`. */
const environmentSettings: PushSettings = () => pushConfig(loadConfig(process.env));

export type SendPushOptions = {
	/**
	 * What this notification is about, so each device's filter can judge it.
	 *
	 * Omitted means "send to everyone who would take a request", which is what the
	 * only caller did before preferences existed.
	 */
	about?: Notifiable;
	settings?: PushSettings;
	/** Test seam: what actually talks to the push service. */
	send?: (
		subscription: WebPushSubscription,
		payload: string,
		options: webpush.RequestOptions
	) => Promise<unknown>;
};

/**
 * Send one message to every subscription, pruning the dead ones as it goes.
 *
 * Sends run concurrently: they are independent HTTP calls to services that have
 * nothing to do with each other, and doing them in series would make the slowest
 * push service decide how long the owner waits to hear about a blocked agent.
 *
 * Never throws. A notification that cannot be delivered is not a reason to fail
 * whatever was being done when it was raised — the request is already stored,
 * and the dashboard will show it the moment anybody looks.
 */
export async function sendPush(
	ctx: DomainContext,
	message: PushMessage,
	options: SendPushOptions = {}
): Promise<PushResult> {
	const settings = (options.settings ?? environmentSettings)();
	if (settings === null) return { sent: 0, removed: 0, failed: 0 };

	const about = options.about ?? { type: 'request' as const };
	// Filtered here rather than by the caller: whether a device wants this is a
	// property of the device, and the caller has one message and no idea who is
	// subscribed.
	const subscriptions = listPushSubscriptions(ctx.db).filter((subscription) =>
		notifies(subscription.prefs, about)
	);
	if (subscriptions.length === 0) return { sent: 0, removed: 0, failed: 0 };

	const deliver =
		options.send ??
		((subscription, payload, requestOptions) =>
			webpush.sendNotification(subscription, payload, requestOptions));

	const payload = JSON.stringify(message);
	const result: PushResult = { sent: 0, removed: 0, failed: 0 };

	await Promise.all(
		subscriptions.map(async (subscription) => {
			try {
				await deliver(
					{
						endpoint: subscription.endpoint,
						keys: { p256dh: subscription.p256dh, auth: subscription.auth }
					},
					payload,
					{
						vapidDetails: {
							subject: settings.subject,
							publicKey: settings.publicKey,
							privateKey: settings.privateKey
						},
						TTL: PUSH_TTL_S
					}
				);
				markPushSent(ctx.db, subscription.endpoint, ctx.now());
				result.sent += 1;
			} catch (error) {
				if (isGone(error)) {
					deletePushSubscription(ctx.db, subscription.endpoint);
					result.removed += 1;
					return;
				}

				const failures = markPushFailed(ctx.db, subscription.endpoint);
				if (failures >= MAX_PUSH_FAILURES) {
					deletePushSubscription(ctx.db, subscription.endpoint);
					result.removed += 1;
					return;
				}
				result.failed += 1;
			}
		})
	);

	return result;
}

/**
 * How long a push service should hold a notification for a device that is off.
 *
 * A quarter of an hour, not a day: the default request deadline is an hour, and
 * a notification that arrives after the request it is about has expired sends
 * the owner to a dashboard with nothing on it.
 */
export const PUSH_TTL_S = 15 * 60;

/** A push service saying this subscription no longer exists. Definitive. */
function isGone(error: unknown): boolean {
	const status = (error as { statusCode?: number } | null)?.statusCode;
	return status === 404 || status === 410;
}

/**
 * The notification for one blocked agent, or `null` if there is nothing to say.
 *
 * `null` rather than a thrown error for a request that has already been answered
 * or has vanished: by the time this runs the owner may have answered it in an
 * open tab, and a notification about a settled request is worse than none.
 */
export function requestMessage(
	ctx: DomainContext,
	requestId: string,
	/** The deployment's public origin: a service worker has no page to be relative to. */
	base: string
): PushMessage | null {
	const request = findRequest(ctx, requestId);
	if (!request || request.state !== 'pending') return null;

	const agent = findAgentById(ctx.db, request.agentId);
	const who = agent?.name ?? 'An agent';
	const project = request.projectId ? findProjectById(ctx.db, request.projectId) : undefined;

	const message: PushMessage = {
		title: `${who} is waiting on you`,
		body: request.question,
		url: project ? `${base}/projects/${project.slug}` : base,
		tag: `request-${request.id}`,
		requestId: request.id
	};

	const actions = actionsFor(request.kind, request.options);
	if (actions.length > 0) message.actions = actions;

	return message;
}

/**
 * The buttons a notification can carry, for the kinds one tap can settle.
 *
 * `text`, `multi_choice` and `form` get none on purpose: each needs something
 * typed or several things picked, and a button that says "Approve" over a
 * message the owner has not read — let alone edited — would be the one way to
 * make a `form` dangerous. Those open the card instead.
 *
 * `buttons` and `choice` offer their first {@link MAX_PUSH_ACTIONS} options
 * rather than a truncated list, because the notification is a shortcut and the
 * card is the complete control.
 */
function actionsFor(kind: OwnerRequest['kind'], options: string[] | null): PushAction[] {
	if (kind === 'confirm') {
		return [
			{ action: 'confirm-yes', title: 'Approve', value: true },
			{ action: 'confirm-no', title: 'Reject', value: false }
		];
	}

	if (kind === 'buttons' || kind === 'choice') {
		return (options ?? []).slice(0, MAX_PUSH_ACTIONS).map((option, index) => ({
			action: `option-${index}`,
			title: option,
			value: option
		}));
	}

	return [];
}

/** The first line of a body, for a notification that has one line to say it in. */
function firstLine(body: string, max = 140): string {
	const flat = body.replace(/\s+/g, ' ').trim();
	return flat.length <= max ? flat : `${flat.slice(0, max).trimEnd()}…`;
}

/** Where a notification about a project should land. */
function projectUrl(ctx: DomainContext, projectId: string | null, base: string): string {
	if (!projectId) return base;
	const project = findProjectById(ctx.db, projectId);
	return project ? `${base}/projects/${project.slug}` : base;
}

/**
 * The notification for one posted update, or `null` if there is nothing to say.
 *
 * Carries the level and priority as {@link Notifiable}, which is what each
 * device's filter reads — the payload itself says nothing about either, because
 * a notification that announced its own priority would be one more thing to read
 * before deciding whether to care.
 */
export function updateMessage(
	ctx: DomainContext,
	updateId: string,
	base: string
): { message: PushMessage; about: Notifiable } | null {
	const update = findUpdateById(ctx.db, updateId);
	if (!update || update.deletedAt !== null) return null;

	const agent = findAgentById(ctx.db, update.agentId);
	return {
		message: {
			title: update.title ?? `${agent?.name ?? 'An agent'} posted an update`,
			body: update.title ? firstLine(update.body) : firstLine(update.body),
			url: projectUrl(ctx, update.projectId, base),
			tag: `update-${update.id}`
		},
		about: { type: 'update', level: update.level, priority: update.priority }
	};
}

/**
 * Whether an agent's message answers the owner, or is a note to the room.
 *
 * The two are different events and the owner asked to be told about them
 * differently: "commenting is just replying to a thread, to anyone; replying is
 * specifically replying to me". A phone that buzzes the same way for both
 * teaches its owner to ignore the one that was aimed at them.
 *
 * **Derived rather than declared.** The alternative was an argument on
 * `post_message` for the agent to set, and an agent deciding whether it is
 * talking *to* the owner would get it wrong in both directions — generously at
 * 2am. What the data already knows is enough:
 *
 * - a reply under one of the owner's own posts answers them by construction;
 * - a message in a thread the owner has spoken in is an answer to what they
 *   said there;
 * - anything else — a note on a card they never touched, one agent talking to
 *   another — is a comment.
 */
export function repliesToOwner(ctx: DomainContext, message: Message): boolean {
	if (message.replyTo !== null) {
		const post = findMessageById(ctx.db, message.replyTo);
		return post?.author === HUMAN_AUTHOR;
	}

	// The thread it landed in, if it is in one. A message with only a project is
	// a note to the project rather than an answer to anybody.
	const scope =
		message.updateId !== null
			? { updateId: message.updateId }
			: message.taskId !== null
				? { taskId: message.taskId }
				: null;
	if (scope === null) return false;

	return listMessages(ctx.db, { ...scope, limit: Number.MAX_SAFE_INTEGER }).some(
		(candidate) => candidate.author === HUMAN_AUTHOR
	);
}

/**
 * The notification for one message an agent wrote.
 *
 * `null` for the owner's own messages, which is the whole reason this checks the
 * author: the owner typing into a thread on their laptop must not buzz their own
 * phone.
 *
 * The `type` is what separates a reply from a comment ({@link repliesToOwner}),
 * and it is what a device filters on — so "tell me when somebody answers me,
 * and leave the rest until I look" is one checkbox rather than a rule nobody
 * can express.
 */
export function replyMessage(
	ctx: DomainContext,
	messageId: string,
	base: string
): { message: PushMessage; about: Notifiable } | null {
	const message = findMessageById(ctx.db, messageId);
	if (!message) return null;

	const author = parseAuthor(message.author);
	if (!author || author.kind !== 'agent') return null;

	const agent = findAgentById(ctx.db, author.agentId);
	const answered = repliesToOwner(ctx, message);
	const name = agent?.name ?? 'An agent';

	return {
		message: {
			title: answered ? `${name} replied to you` : `${name} commented`,
			body: firstLine(message.body),
			url: projectUrl(ctx, message.projectId, base),
			tag: `message-${message.id}`
		},
		about: { type: answered ? 'message' : 'comment' }
	};
}

/** Store one device's preferences. `null` restores the default. */
export function setDevicePrefs(
	ctx: DomainContext,
	endpoint: string,
	prefs: unknown
): PushPrefs | null {
	const checked = assertPushPrefs(prefs);
	if (!setPushPrefs(ctx.db, endpoint, checked)) {
		throw notFound(`no such subscription: ${endpoint}`);
	}
	return checked;
}

export type RequestPusherOptions = {
	context?: () => DomainContext;
	bus?: EventBus;
	settings?: PushSettings;
	/** Test seam, passed through to {@link sendPush}. */
	send?: SendPushOptions['send'];
	onError?: (error: unknown) => void;
	/** The public origin notifications link to. Defaults to `PUBLIC_BASE_URL`. */
	baseUrl?: () => string;
	/** Test seam: build the message yourself. */
	message?: (ctx: DomainContext, requestId: string, base: string) => PushMessage | null;
};

/**
 * Push a notification whenever an agent stops on the owner.
 *
 * Subscribed to the bus rather than called from `createRequest`, for the same
 * reason the SSE route is: the domain publishes one event per write and
 * everything that cares hangs off it, so an agent's tool call never waits on a
 * push service to answer before it is told its request was accepted.
 *
 * @returns an unsubscribe, so a test can take it back off the bus.
 */
export function startRequestPusher(options: RequestPusherOptions = {}): () => void {
	const {
		context: getContext = sharedContext,
		bus = sharedBus,
		onError = (error: unknown) => console.error('push notification failed', error),
		baseUrl = () => loadConfig(process.env).PUBLIC_BASE_URL,
		message = requestMessage
	} = options;

	return bus.subscribe((event) => {
		if (
			event.type !== 'request.created' &&
			event.type !== 'update.created' &&
			event.type !== 'message.created'
		) {
			return;
		}

		// Deliberately not awaited: fan-out never blocks on a subscriber, and this
		// one talks to the internet. Failures are handled inside `sendPush`; this
		// catch is for the lookups that build the message.
		void (async () => {
			try {
				const ctx = getContext();
				const base = baseUrl();

				if (event.type === 'request.created') {
					const built = message(ctx, event.payload.requestId, base);
					if (built === null) return;
					await sendPush(ctx, built, {
						about: { type: 'request' },
						settings: options.settings,
						send: options.send
					});
					return;
				}

				const built =
					event.type === 'update.created'
						? updateMessage(ctx, event.payload.updateId, base)
						: replyMessage(ctx, event.payload.messageId, base);
				if (built === null) return;

				await sendPush(ctx, built.message, {
					about: built.about,
					settings: options.settings,
					send: options.send
				});
			} catch (error) {
				onError(error);
			}
		})();
	});
}
