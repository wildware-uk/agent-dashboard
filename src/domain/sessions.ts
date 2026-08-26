/**
 * Sessions and presence: which agents are alive right now (design §3, §4, §5).
 *
 * ## Presence is derived, never a stored flag
 *
 * There is no `online` column, and there never should be. An agent is online
 * when one of its open sessions has beaten within {@link PRESENCE_WINDOW_MS}
 * (design §4), so presence is a question asked of two timestamps and the answer
 * cannot rot: a process that dies mid-write leaves no flag stuck on, and a
 * browser that has the row can answer the question itself as its own clock
 * moves. Every function here reads that derivation; none of them writes it down.
 *
 * ## Events fire on transitions, not on heartbeats
 *
 * A heartbeat is the most frequent write in the product — one per agent every
 * {@link HEARTBEAT_INTERVAL_S} seconds, forever — and every event published
 * goes down every open SSE connection (§4). So a heartbeat publishes
 * `agent.presence` only when the derivation *changes*: the agent was outside the
 * window (or had no session at all) and now is not. A storm of beats from a
 * healthy agent publishes nothing, which is asserted in `./sessions.test.ts`.
 *
 * The transition is computed from the database on both sides of the write, so
 * this module holds no in-memory presence state that a restart could lose or a
 * second reader could disagree with.
 *
 * One consequence is worth stating plainly, because it looks like a gap: the
 * moment an agent crosses the 90 second line **nothing writes anything**, so
 * there is no transition to publish and no event is sent. Going offline by
 * silence is therefore observed rather than announced — the rail re-derives
 * presence from `lastHeartbeatAt` against its own clock, and refetches on a slow
 * poll, so an agent that stops beating drops off screen on time without the
 * server having to tick for it. What the sweeper below adds is not the
 * announcement but the cleanup.
 *
 * ## The sweeper
 *
 * {@link sweepSessions} closes sessions idle beyond {@link SESSION_IDLE_MS}.
 * That is what makes a later approval gate aimed at a dead agent fail loudly:
 * the session is closed, so the agent's own next heartbeat is refused with a
 * `conflict` telling it to register again, and nothing is left open for a gate
 * to wait on forever.
 */
import {
	endSession as closeSessionRow,
	endStaleSessions,
	findAgentById,
	findSessionById,
	heartbeatSession,
	insertSession,
	listLiveSessions,
	listSessionsForAgent,
	type Session,
	type SessionMeta
} from '$db';
import { context, type DomainContext } from './context';
import { conflict, invalid, notFound } from './errors';
import { countPendingRequests } from './requests';
import { countUnreadMessages } from './messages';
import { countOpenTasks } from './tasks';
import { optionalText } from './text';

/**
 * How often an agent is told to beat.
 *
 * Three beats fit inside the presence window, so a dropped call or a slow tool
 * round trip cannot flap an agent offline.
 */
export const HEARTBEAT_INTERVAL_S = 30;

/** How recently a session must have beaten for its agent to count as online (§4). */
export const PRESENCE_WINDOW_MS = 90_000;

/** How long a session may be idle before the sweeper closes it (§4). */
export const SESSION_IDLE_MS = 10 * 60_000;

/** How often {@link startPresenceSweeper} looks for sessions to close. */
export const SWEEP_INTERVAL_MS = 60_000;

/** Long enough for a hostname, an absolute path, and a model name. */
export const HOST_MAX_LENGTH = 200;
export const CWD_MAX_LENGTH = 1_000;
export const MODEL_MAX_LENGTH = 100;

/** The keys of `sessions.meta` this product understands (design §3). */
const META_FIELDS = [
	['host', HOST_MAX_LENGTH],
	['cwd', CWD_MAX_LENGTH],
	['model', MODEL_MAX_LENGTH]
] as const;

export type RegisterSessionInput = {
	/**
	 * The agent registering. Adapters resolve this from the bearer token and
	 * never from a caller-supplied argument (design §5).
	 */
	agentId: string;
	/** Where the agent is running: `host`, `cwd`, `model`. Anything else is dropped. */
	meta?: SessionMeta | null;
};

/** What an agent needs to keep itself alive: the session, and how often to beat. */
export type RegisteredSession = { session: Session; heartbeatIntervalS: number };

/**
 * Open a session for an agent.
 *
 * Registering counts as the first heartbeat, so an agent is online the moment it
 * announces itself rather than at its first beat.
 *
 * A second concurrent session is allowed on purpose: one token can be in use by
 * two runs on two machines, and the honest answer is two sessions, not a
 * silently reassigned one.
 *
 * @throws {DomainError} `not_found` if there is no such agent.
 */
export function registerSession(
	ctx: DomainContext,
	input: RegisterSessionInput
): RegisteredSession {
	const agent = findAgentById(ctx.db, input.agentId);
	if (!agent) throw notFound(`no such agent: ${input.agentId}`);

	const at = ctx.now();
	const meta = cleanMeta(input.meta);
	// Read before the insert: afterwards every agent is online, so there would be
	// no transition left to see.
	const wasOnline = onlineAt(ctx, agent.id, at);

	const session = insertSession(ctx.db, { agentId: agent.id, startedAt: at, meta });
	if (!wasOnline) announce(ctx, agent.id, session.id, true);

	return { session, heartbeatIntervalS: HEARTBEAT_INTERVAL_S };
}

export type HeartbeatInput = {
	sessionId: string;
	/** From the bearer token. The session must belong to this agent. */
	agentId: string;
};

/**
 * What a heartbeat answers with: that it landed, plus the work waiting.
 *
 * The counts are piggybacked so an agent discovers there is something for it
 * without polling three separate tools (design §5).
 */
export type Heartbeat = { ok: true } & WorkCounts;

/**
 * Record a heartbeat and report the work waiting for this agent.
 *
 * @throws {DomainError} `not_found` for an unknown session, `invalid_argument`
 *   for another agent's session, `conflict` for a session that has ended — which
 *   is how a swept agent learns to call `register_session` again rather than
 *   beating into a run nobody is watching.
 */
export function heartbeat(ctx: DomainContext, input: HeartbeatInput): Heartbeat {
	const at = ctx.now();
	const session = ownSession(ctx, input.sessionId, input.agentId);
	if (session.endedAt !== null) throw endedSession(session.id);

	const wasOnline = onlineAt(ctx, session.agentId, at);
	if (!heartbeatSession(ctx.db, session.id, at)) throw endedSession(session.id);
	// Only a transition is worth an event: a healthy agent beats forever, and
	// publishing each one would flood every open stream (design §4).
	if (!wasOnline) announce(ctx, session.agentId, session.id, true);

	return { ok: true, ...countWork(ctx, session.agentId) };
}

export type EndSessionInput = { sessionId: string; agentId: string };

/** The closed session, and whether this call was the one that closed it. */
export type EndSessionResult = { session: Session; ended: boolean };

/**
 * Close a session.
 *
 * Idempotent, and deliberately quiet the second time: the run is already over,
 * so a second `agent.presence` would announce nothing.
 *
 * @throws {DomainError} `not_found` for an unknown session, `invalid_argument`
 *   for another agent's session.
 */
export function endSession(ctx: DomainContext, input: EndSessionInput): EndSessionResult {
	const at = ctx.now();
	const session = ownSession(ctx, input.sessionId, input.agentId);
	if (session.endedAt !== null) return { session, ended: false };

	const wasOnline = onlineAt(ctx, session.agentId, at);
	closeSessionRow(ctx.db, session.id, at);
	// A second run of the same agent may still be beating, in which case the
	// agent has not gone anywhere and there is no transition to report.
	if (wasOnline && !onlineAt(ctx, session.agentId, at)) {
		announce(ctx, session.agentId, session.id, false);
	}

	return { session: findSessionById(ctx.db, session.id)!, ended: true };
}

/** Is this agent online right now, by the §4 derivation? */
export function isAgentOnline(
	ctx: DomainContext,
	agentId: string,
	at: number = ctx.now()
): boolean {
	return onlineAt(ctx, agentId, at);
}

/**
 * One live agent as the right rail renders it (design §7).
 *
 * `host`, `cwd` and `model` are lifted out of `sessions.meta` rather than passed
 * through wholesale: the rail is the one place agent-reported text reaches the
 * owner's screen, and a payload with only named fields cannot carry a surprise.
 */
export type LiveAgent = {
	agentId: string;
	name: string;
	/** The agent's most recently beating session — the run the rail describes. */
	sessionId: string;
	startedAt: number;
	lastHeartbeatAt: number;
	/** How many live sessions this agent has, so two runs are visible as two. */
	sessions: number;
	host: string | null;
	cwd: string | null;
	model: string | null;
};

/**
 * Every agent that is online, most recently heard from first.
 *
 * One row per agent, not per session: a rail that listed the same name twice
 * would read as two agents. The count says otherwise.
 */
export function listLiveAgents(ctx: DomainContext, at: number = ctx.now()): LiveAgent[] {
	const live = listLiveSessions(ctx.db, at - PRESENCE_WINDOW_MS);
	const byAgent = new Map<string, LiveAgent>();

	// `listLiveSessions` orders by heartbeat, newest first, so the first session
	// seen for an agent is the one worth describing and the map's insertion order
	// is already the order the rail wants.
	for (const session of live) {
		const known = byAgent.get(session.agentId);
		if (known) {
			known.sessions += 1;
			continue;
		}

		const agent = findAgentById(ctx.db, session.agentId);
		// A session with no agent row cannot happen through a foreign key, and
		// inventing a name for one would put a fiction in the rail.
		if (!agent) continue;

		byAgent.set(session.agentId, {
			agentId: agent.id,
			name: agent.name,
			sessionId: session.id,
			startedAt: session.startedAt,
			lastHeartbeatAt: session.lastHeartbeatAt,
			sessions: 1,
			host: metaField(session.meta, 'host'),
			cwd: metaField(session.meta, 'cwd'),
			model: metaField(session.meta, 'model')
		});
	}

	return [...byAgent.values()];
}

/** What one sweep did. */
export type SweepResult = {
	/** Ids of the sessions it closed. */
	closed: string[];
	/** Agents that went offline as a result, and were announced as such. */
	wentOffline: string[];
};

export type SweepOptions = {
	/** Idle tolerance. Defaults to {@link SESSION_IDLE_MS}. */
	idleMs?: number;
};

/**
 * Close every session idle beyond the tolerance, and announce any agent that
 * actually went offline because of it.
 *
 * In a normal deployment `wentOffline` is empty: ten minutes of silence is
 * eight and a half minutes past the point where the agent stopped counting as
 * present, so the browser rendered it offline long ago and an event now would
 * announce nothing. The sweep is cleanup — it makes the *session* gone, so the
 * agent's next heartbeat is refused and a gate aimed at that run fails loudly
 * instead of hanging (design §4).
 */
export function sweepSessions(ctx: DomainContext, options: SweepOptions = {}): SweepResult {
	const at = ctx.now();
	const idleMs = options.idleMs ?? SESSION_IDLE_MS;

	const onlineBefore = new Set(
		listLiveSessions(ctx.db, at - PRESENCE_WINDOW_MS).map((session) => session.agentId)
	);
	const closed = endStaleSessions(ctx.db, { idleBefore: at - idleMs, at });

	const touched = new Set<string>();
	for (const id of closed) {
		const session = findSessionById(ctx.db, id);
		if (session) touched.add(session.agentId);
	}

	const wentOffline: string[] = [];
	for (const agentId of touched) {
		if (!onlineBefore.has(agentId) || onlineAt(ctx, agentId, at)) continue;
		// No session id: the sweep closed the agent's own idea of its run, and
		// naming one of several closed sessions would suggest the others survived.
		announce(ctx, agentId, null, false);
		wentOffline.push(agentId);
	}

	return { closed, wentOffline };
}

export type PresenceSweeperOptions = {
	/** Defaults to the process-wide db, bus and clock. Tests pass a harness. */
	context?: () => DomainContext;
	/** Defaults to {@link SWEEP_INTERVAL_MS}. */
	intervalMs?: number;
	/** Idle tolerance. Defaults to {@link SESSION_IDLE_MS}. */
	idleMs?: number;
	/** Defaults to logging: a sweep that throws is a bug worth seeing. */
	onError?: (error: unknown) => void;
};

/**
 * Run {@link sweepSessions} on a timer.
 *
 * The context is resolved per tick rather than captured, so starting the sweeper
 * at boot does not open the database before the first request needs it. A tick
 * that throws is reported and the timer survives: one bad sweep must not leave
 * every later session to accumulate forever.
 *
 * @returns a function that stops it. Idempotent.
 */
export function startPresenceSweeper(options: PresenceSweeperOptions = {}): () => void {
	const {
		context: getContext = context,
		intervalMs = SWEEP_INTERVAL_MS,
		idleMs = SESSION_IDLE_MS,
		onError = (error: unknown) => console.error('presence sweep failed', error)
	} = options;

	const timer = setInterval(() => {
		try {
			sweepSessions(getContext(), { idleMs });
		} catch (error) {
			onError(error);
		}
	}, intervalMs);
	// A pending sweep must not keep the process alive at shutdown.
	timer.unref?.();

	return () => clearInterval(timer);
}

/** The work waiting for an agent, as a heartbeat reports it (design §5). */
export type WorkCounts = {
	unreadMessages: number;
	openTasks: number;
	pendingApprovals: number;
};

/** How one count is answered. */
export type WorkCounter = (ctx: DomainContext, agentId: string) => number;

/**
 * The seam the control-plane slices fill in.
 *
 * Each slice replaced **one function here** as it landed — nothing about the
 * heartbeat response moved, and no agent's parsing of it changed. Tasks (#11),
 * messages (#14) and owner requests (#15) have each done exactly that, and the
 * seam is now fully filled in.
 */
export const WORK_COUNTERS: Record<keyof WorkCounts, WorkCounter> = {
	/** Messages after this agent's cursor, its own excluded (`./messages.ts`). */
	unreadMessages: (ctx, agentId) => countUnreadMessages(ctx, agentId),
	/** This agent's `todo` and `claimed` rows (`./tasks.ts`). */
	openTasks: (ctx, agentId) => countOpenTasks(ctx, agentId),
	/**
	 * This agent's requests still waiting on the owner (`./requests.ts`).
	 *
	 * The name stays `pendingApprovals` because it is the field agents already
	 * parse out of a heartbeat (design §5) — an approval is one kind of owner
	 * request, and renaming the wire format to say so would break every client
	 * for a word.
	 */
	pendingApprovals: (ctx, agentId) => countPendingRequests(ctx, agentId)
};

/** Answer every count for one agent. */
export function countWork(
	ctx: DomainContext,
	agentId: string,
	counters: Record<keyof WorkCounts, WorkCounter> = WORK_COUNTERS
): WorkCounts {
	return {
		unreadMessages: counters.unreadMessages(ctx, agentId),
		openTasks: counters.openTasks(ctx, agentId),
		pendingApprovals: counters.pendingApprovals(ctx, agentId)
	};
}

/** The §4 derivation, in one place so nothing can implement it differently. */
function onlineAt(ctx: DomainContext, agentId: string, at: number): boolean {
	const cutoff = at - PRESENCE_WINDOW_MS;
	return listSessionsForAgent(ctx.db, agentId, { openOnly: true }).some(
		(session) => session.lastHeartbeatAt >= cutoff
	);
}

function announce(
	ctx: DomainContext,
	agentId: string,
	sessionId: string | null,
	online: boolean
): void {
	ctx.bus.publish('agent.presence', { agentId, sessionId, online });
}

/**
 * The session, if it is this agent's.
 *
 * The belongs-to check is the same rule `postUpdate` keeps: identity comes from
 * the token, so a session id guessed or copied from another agent must not let
 * one agent keep another's run alive — or end it.
 */
function ownSession(ctx: DomainContext, sessionId: string, agentId: string): Session {
	const session = findSessionById(ctx.db, sessionId);
	if (!session) throw notFound(`no such session: ${sessionId}`);
	if (session.agentId !== agentId) throw invalid('session belongs to another agent');
	return session;
}

function endedSession(sessionId: string) {
	return conflict(`session ${sessionId} has ended; call register_session to start a new one`);
}

/**
 * Keep the three fields §3 names, and nothing else.
 *
 * Meta is agent-authored and ends up on the owner's screen, so it is validated
 * like any other agent input rather than stored as handed over: unknown keys are
 * dropped, values must be text, and a payload of nothing but blanks becomes
 * `null` rather than an empty object.
 */
function cleanMeta(meta: SessionMeta | null | undefined): SessionMeta | null {
	if (!meta) return null;

	const cleaned: Record<string, string> = {};
	for (const [field, maxLength] of META_FIELDS) {
		const raw = meta[field];
		if (raw === undefined || raw === null) continue;
		if (typeof raw !== 'string') throw invalid(`meta.${field} must be a string`);
		const text = optionalText(raw, `meta.${field}`, maxLength);
		if (text !== null) cleaned[field] = text;
	}

	return Object.keys(cleaned).length === 0 ? null : cleaned;
}

/** One meta field, defensively: a stored non-string reads as absent, never renders. */
function metaField(meta: SessionMeta | null, field: 'host' | 'cwd' | 'model'): string | null {
	const value = meta?.[field];
	return typeof value === 'string' && value !== '' ? value : null;
}
