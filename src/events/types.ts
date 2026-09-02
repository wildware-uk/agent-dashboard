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

/** What an agent is saying about a message or a task (migration 013). */
export type AckState = 'thinking' | 'read' | 'done';

/** The shapes an owner request takes (design §5). */
export type RequestKind = 'text' | 'confirm' | 'buttons' | 'choice' | 'multi_choice' | 'form';

/**
 * How a pending request ended. `pending` is not an outcome, so it is absent.
 *
 * `answered` covers all five kinds: what the owner actually said is a string, a
 * boolean or a list depending on the kind, and none of that belongs on the wire
 * here — a waiter re-reads the row, which is the durable copy either way.
 */
export type RequestOutcome = 'answered' | 'timeout' | 'cancelled';

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
	/**
	 * An update the owner curated in place — today only its pin (design §7).
	 *
	 * §4 lists the events this design foresaw, and pinning an existing update was
	 * not among them: it is the one owner action that neither creates nor removes
	 * a row, so neither `update.created` nor `update.deleted` can carry it
	 * without lying to every other subscriber about what happened. The browser
	 * has to hear about it — a pin reorders the timeline in every open tab — so
	 * the vocabulary gains a member rather than an existing one gaining a second
	 * meaning. `pinned` rides along so a subscriber can decide whether it cares
	 * before refetching.
	 */
	'update.updated': { updateId: string; projectId: string; pinned: boolean };
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
	/**
	 * A message is gone: the owner deleted it, or the agent that wrote it
	 * unsent it (migration 017).
	 *
	 * Soft, like `update.deleted`, and announced for the same reason: every tab
	 * that already rendered the line has to be told to drop it, and a thread
	 * that kept showing an unsent message in one window and not another would be
	 * the worst kind of disagreement — the owner cannot tell which one is right.
	 *
	 * `replies` rides along because deleting a post takes its replies with it,
	 * and a subscriber that knows how many lines went can decide whether it
	 * cares before refetching.
	 */
	'message.deleted': { messageId: string; projectId: string | null; replies: number };
	/**
	 * An agent's read cursor moved, so its unread count fell (design §5).
	 *
	 * The only *read* that publishes, and it earns the exception: `unread_messages`
	 * is state anything watching an agent has to track, and `get_messages` is the
	 * one thing that lowers it. Without this the count changes in silence, every
	 * listener keeps a stale figure, and the next real message looks like a fall
	 * against it — which is exactly how a live channel went quiet.
	 */
	'messages.read': { agentId: string; cursor: number };
	/**
	 * An agent has stopped and is waiting on its owner (design §5).
	 *
	 * `kind` rides along because it decides which control the sticky banner
	 * renders, and a browser that already knows can show the prompt from the
	 * frame before its refetch lands.
	 */
	'request.created': {
		requestId: string;
		agentId: string;
		projectId: string | null;
		kind: RequestKind;
	};
	/**
	 * A request is settled, however it ended: answered, timed out, or dismissed.
	 *
	 * One name for all three because every parked waiter unblocks on this one
	 * event (design §5), and a waiter that had to subscribe to three names to
	 * learn its wait was over would miss the one it forgot. The answer itself is
	 * deliberately not here — the row is the authority, and a waiter re-reads it.
	 */
	'request.answered': {
		requestId: string;
		agentId: string;
		state: RequestOutcome;
		settledAt: string;
	};
	/**
	 * An agent has said something about a message or a task without saying it in
	 * words: "I have this" or "this is done".
	 *
	 * One name for both states, and for a first acknowledgement and a revision
	 * alike, because there is only ever one row per agent per thing — a browser
	 * hearing this refetches and reconciles by id like every other subscriber,
	 * and a second event name would be a distinction nothing acts on.
	 *
	 * `state` rides along so a subscriber can decide whether it cares before
	 * refetching, exactly as `pinned` does on `update.updated`.
	 */
	'ack.updated': {
		ackId: string;
		agentId: string;
		messageId: string | null;
		taskId: string | null;
		state: AckState;
	};
	/**
	 * The owner renamed an agent.
	 *
	 * The name rides in the timeline snapshot rather than on each card, so a
	 * browser hearing this refetches once and every card that agent ever posted
	 * is relabelled together. `name` is on the payload so a subscriber can decide
	 * whether it cares before asking for anything.
	 */
	'agent.renamed': { agentId: string; name: string };
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
