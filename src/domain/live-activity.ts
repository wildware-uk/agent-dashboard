/**
 * Keeps the iOS Live Activity in step with the dashboard.
 *
 * The lock screen shows how many agents are online, how many are waiting on
 * the owner, and the oldest question. Anything that could change one of those
 * schedules a recompute; recomputes are coalesced, and a phone is only sent a
 * state that differs from the last one it got, because Apple budgets Live
 * Activity pushes.
 *
 * A phone with no activity running but a push-to-start token is started when a
 * new request arrives, which is how the activity appears without opening the
 * app.
 */
import { listOwnerDevices, type OwnerDevice } from '$db';
import { bus as sharedBus, type AppEvent, type EventBus } from '$events';
import { loadConfig } from '$config';
import {
	deliverToDevice,
	environmentApnsSettings,
	sharedApnsTransport,
	type ApnsSettings,
	type ApnsTransport
} from './apns';
import { context as sharedContext, type DomainContext } from './context';
import { requestMessage } from './push';
import { liveActivityState, ownerSummary, type LiveActivityState } from './summary';

/** The ActivityAttributes type name the app declares. */
export const LIVE_ACTIVITY_ATTRIBUTES_TYPE = 'AgentsActivityAttributes';

export const LIVE_ACTIVITY_COALESCE_MS = 2_000;

/** Presence expires without an event, so the count is re-read on a timer too. */
export const LIVE_ACTIVITY_REFRESH_MS = 60_000;

/** One start per phone per window, so a burst of questions is one activity. */
export const PUSH_TO_START_COOLDOWN_MS = 5 * 60 * 1000;

const WATCHED: ReadonlySet<AppEvent['type']> = new Set([
	'request.created',
	'request.answered',
	'request.updated',
	'agent.presence',
	'agent.renamed',
	'update.created',
	'update.updated',
	'update.deleted',
	'message.created',
	'message.updated',
	'message.deleted',
	'project.created',
	'project.updated'
]);

export type LiveActivityPusherOptions = {
	context?: () => DomainContext;
	bus?: EventBus;
	settings?: ApnsSettings;
	transport?: ApnsTransport;
	baseUrl?: () => string;
	coalesceMs?: number;
	refreshMs?: number;
	onError?: (error: unknown) => void;
};

export type LiveActivityPusher = {
	/** Recompute and send now. Resolves when every send has settled. */
	flush(): Promise<void>;
	stop(): void;
};

export function liveActivityHeaders(bundleId: string, priority: 5 | 10): Record<string, string> {
	return {
		'apns-push-type': 'liveactivity',
		'apns-topic': `${bundleId}.push-type.liveactivity`,
		'apns-priority': String(priority)
	};
}

export function createLiveActivityPusher(
	options: LiveActivityPusherOptions = {}
): LiveActivityPusher {
	const {
		context: getContext = sharedContext,
		bus = sharedBus,
		settings: getSettings = environmentApnsSettings,
		baseUrl = () => loadConfig(process.env).PUBLIC_BASE_URL,
		coalesceMs = LIVE_ACTIVITY_COALESCE_MS,
		refreshMs = LIVE_ACTIVITY_REFRESH_MS,
		onError = (error: unknown) => console.error('live activity push failed', error)
	} = options;

	// Keyed by device and token, so a fresh activity is sent its first state.
	const lastSent = new Map<string, LiveActivityState>();
	const startedAt = new Map<string, number>();
	let newRequestId: string | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let running: Promise<void> | null = null;
	let again = false;

	const run = async (): Promise<void> => {
		const settings = getSettings();
		if (settings === null) return;
		const transport = options.transport ?? sharedApnsTransport(settings);

		const ctx = getContext();
		const requestId = newRequestId;
		newRequestId = null;
		const devices = listOwnerDevices(ctx.db);
		if (!devices.some((device) => device.liveActivityToken || device.pushToStartToken)) return;

		const now = ctx.now();
		const state = liveActivityState(ownerSummary(ctx));
		const json = JSON.stringify(state);
		const timestamp = Math.floor(now / 1000);

		const updates = devices
			.filter((device): device is OwnerDevice & { liveActivityToken: string } =>
				Boolean(device.liveActivityToken)
			)
			.map(async (device) => {
				const key = `${device.id}:${device.liveActivityToken}`;
				const previous = lastSent.get(key);
				if (previous && JSON.stringify(previous) === json) return;

				const urgent = state.waiting > 0 || previous?.waiting !== state.waiting;
				const outcome = await deliverToDevice(
					ctx,
					transport,
					device,
					'live_activity_token',
					liveActivityHeaders(settings.bundleId, urgent ? 10 : 5),
					{ aps: { timestamp, event: 'update', 'content-state': state } },
					onError
				);
				if (outcome === 'sent') lastSent.set(key, state);
				else lastSent.delete(key);
			});

		const starts =
			requestId === null || state.waiting === 0
				? []
				: devices
						.filter(
							(device) =>
								device.pushToStartToken &&
								!device.liveActivityToken &&
								now - (startedAt.get(device.id) ?? -Infinity) >= PUSH_TO_START_COOLDOWN_MS
						)
						.map(async (device) => {
							const message = requestMessage(ctx, requestId, baseUrl());
							const alert = {
								title: message?.title ?? `${state.topAgent ?? 'An agent'} is waiting on you`,
								body: message?.body ?? state.topQuestion ?? ''
							};
							startedAt.set(device.id, now);
							await deliverToDevice(
								ctx,
								transport,
								device,
								'push_to_start_token',
								liveActivityHeaders(settings.bundleId, 10),
								{
									aps: {
										timestamp,
										event: 'start',
										'content-state': state,
										'attributes-type': LIVE_ACTIVITY_ATTRIBUTES_TYPE,
										attributes: {},
										alert
									}
								},
								onError
							);
						});

		await Promise.all([...updates, ...starts]);
	};

	const flush = async (): Promise<void> => {
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
		if (running) {
			again = true;
			return running;
		}
		running = (async () => {
			try {
				do {
					again = false;
					try {
						await run();
					} catch (error) {
						onError(error);
					}
				} while (again);
			} finally {
				running = null;
			}
		})();
		return running;
	};

	const schedule = () => {
		if (timer !== null) return;
		timer = setTimeout(() => {
			timer = null;
			void flush();
		}, coalesceMs);
	};

	const unsubscribe = bus.subscribe((event) => {
		if (!WATCHED.has(event.type)) return;
		if (event.type === 'request.created') newRequestId = event.payload.requestId;
		schedule();
	});

	const refresh = setInterval(schedule, refreshMs);
	refresh.unref?.();

	return {
		flush,
		stop() {
			unsubscribe();
			clearInterval(refresh);
			if (timer !== null) clearTimeout(timer);
			timer = null;
		}
	};
}

/** Start the sender for the process. @returns a stop function. */
export function startLiveActivityPusher(options: LiveActivityPusherOptions = {}): () => void {
	return createLiveActivityPusher(options).stop;
}
