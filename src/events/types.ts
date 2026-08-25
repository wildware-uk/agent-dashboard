/**
 * The event vocabulary of the whole application (design §4).
 *
 * `src/events/` is a leaf: it imports nothing from the tree, so it owns these
 * shapes rather than borrowing row types from `$db` or `$domain`. Payloads are
 * deliberately thin — identifiers plus the few scalars a browser needs to decide
 * whether it cares — because every event is serialised onto the SSE stream, and
 * a fat payload would make the bus a second, drifting copy of the data model.
 */

/** Media a payload can describe (design §3). */
export type MediaKind = 'image' | 'video';

/** Lifecycle of a task (design §3). */
export type TaskState = 'todo' | 'claimed' | 'done' | 'cancelled';

/** How a pending approval ended. `pending` is not a decision, so it is absent. */
export type ApprovalOutcome = 'approved' | 'rejected' | 'timeout' | 'cancelled';

/**
 * Every event type, mapped to its payload.
 *
 * Adding a key here is all it takes to add an event: `publish` and every
 * subscriber narrow off this map, so a payload that does not match its type is a
 * compile error at the call site.
 */
export interface EventPayloads {
	'project.created': { projectId: string; slug: string };
	'project.updated': { projectId: string; slug: string };
	'update.created': { updateId: string; projectId: string; agentId: string };
	/** Deletes are soft, so the browser is told to drop a row it already rendered. */
	'update.deleted': { updateId: string; projectId: string };
	/** A derivative job finished; the browser swaps its placeholder. */
	'media.ready': { mediaId: string; updateId: string | null; kind: MediaKind };
	'task.created': {
		taskId: string;
		projectId: string;
		agentId: string | null;
		state: TaskState;
	};
	'task.updated': {
		taskId: string;
		projectId: string;
		agentId: string | null;
		state: TaskState;
	};
	/** `author` is the literal `human` or `agent:<agent_id>` (design §3). */
	'message.created': { messageId: string; projectId: string | null; author: string };
	'approval.created': { approvalId: string; agentId: string; projectId: string | null };
	/**
	 * Carries the decision itself, not just the id: every parked waiter unblocks
	 * on this one event (design §5) and can answer its agent without a second read.
	 */
	'approval.decided': {
		approvalId: string;
		agentId: string;
		state: ApprovalOutcome;
		value: string | null;
		decidedAt: string;
	};
	/** Presence is derived from heartbeats, never stored as a flag (design §4). */
	'agent.presence': { agentId: string; sessionId: string | null; online: boolean };
}

/** The name of an event type. */
export type EventName = keyof EventPayloads;

/**
 * The envelope every event travels in: its payload plus the stamps the transport
 * needs.
 */
interface Envelope<Name extends EventName> {
	readonly type: Name;
	/** Monotonic, process-global, starts at 1. The SSE `id:` and replay cursor. */
	readonly seq: number;
	/** ISO 8601, for display and debugging only; ordering comes from `seq`. */
	readonly at: string;
	readonly payload: EventPayloads[Name];
}

/**
 * An event as subscribers see it: the discriminated union of every envelope.
 *
 * Switching on `type` narrows `payload`, so a subscriber cannot read a field the
 * event it is holding does not have.
 */
export type AppEvent = { [Name in EventName]: Envelope<Name> }[EventName];

/** The one member of the union whose type is `K`, e.g. `EventOf<'media.ready'>`. */
export type EventOf<K extends EventName> = Extract<AppEvent, { type: K }>;
