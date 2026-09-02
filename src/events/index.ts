/**
 * Public entry point for the event bus.
 *
 * Other modules import from `$events`, never from a file inside it.
 *
 * The `src/events/` slice (design §11 step 3): typed pub/sub plus the ring
 * buffer. See ./README.md for the boundary rules.
 *
 * ```ts
 * import { bus } from '$events';
 *
 * const stop = bus.subscribe((event) => write(event.seq, event));
 * bus.publish('update.created', { updateId, projectId, agentId });
 * const settled = await bus.waitFor({
 * 	types: ['request.answered'],
 * 	where: (event) => event.payload.requestId === id,
 * 	since: createdSeq,
 * 	timeoutMs: config.HOLD_S * 1000
 * });
 * ```
 */
export { EventBus, RING_CAPACITY, bus } from './bus';
export type {
	EventBusOptions,
	EventListener,
	ListenerErrorHandler,
	Unsubscribe,
	WaitOptions
} from './bus';
export type { ReplayMiss, ReplayResult } from './ring';
export type {
	AckState,
	AppEvent,
	EventName,
	EventOf,
	EventPayloads,
	MediaKind,
	RequestKind,
	RequestOutcome,
	TaskState
} from './types';
