import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findSessionById, insertSession, listSessionsForAgent, type SessionMeta } from '$db';
import { FIXED_NOW, harness, type Harness } from './testing';
import {
	HEARTBEAT_INTERVAL_S,
	PRESENCE_WINDOW_MS,
	SESSION_IDLE_MS,
	SWEEP_INTERVAL_MS,
	WORK_COUNTERS,
	countWork,
	endSession,
	heartbeat,
	isAgentOnline,
	listLiveAgents,
	registerSession,
	startPresenceSweeper,
	sweepSessions
} from './sessions';
import { isDomainError, type DomainErrorCode } from './errors';
import { answerRequest, createRequest } from './requests';

let h: Harness;
let now: number;
let agentId: string;

beforeEach(() => {
	now = FIXED_NOW;
	h = harness({ now: () => now });
	agentId = h.agent('scout');
});

/** The code a domain call refused with, so a test can name it. */
function refusalCode(call: () => unknown): DomainErrorCode | undefined {
	try {
		call();
		return undefined;
	} catch (error) {
		return isDomainError(error) ? error.code : undefined;
	}
}

/** Every `agent.presence` payload published so far, in order. */
function presenceEvents() {
	return h.events
		.filter((event) => event.type === 'agent.presence')
		.map(
			(event) => event.payload as { agentId: string; sessionId: string | null; online: boolean }
		);
}

describe('the policy the whole slice hangs off', () => {
	it('asks for heartbeats often enough to miss two and still be online', () => {
		// 90s of tolerance for a 30s beat: a dropped call, or a slow tool round
		// trip, must not flap an agent offline (design §4).
		expect(PRESENCE_WINDOW_MS / (HEARTBEAT_INTERVAL_S * 1000)).toBeGreaterThanOrEqual(2);
	});

	it('closes a session long after it stopped counting as present', () => {
		// Presence is a 90s question; closing a session is a 10 minute one, so a
		// quiet agent is shown as offline long before its session is taken away.
		expect(SESSION_IDLE_MS).toBe(10 * 60_000);
		expect(SESSION_IDLE_MS).toBeGreaterThan(PRESENCE_WINDOW_MS);
	});

	it('sweeps often enough that a dead session cannot outlive its idle window by much', () => {
		expect(SWEEP_INTERVAL_MS).toBeLessThanOrEqual(SESSION_IDLE_MS);
	});
});

describe('registerSession', () => {
	it('opens a session and tells the agent how often to beat', () => {
		const { session, heartbeatIntervalS } = registerSession(h, { agentId });

		expect(heartbeatIntervalS).toBe(HEARTBEAT_INTERVAL_S);
		expect(session).toMatchObject({
			agentId,
			startedAt: FIXED_NOW,
			// Registering is itself the first heartbeat, so the agent is online
			// without having to beat before its first real piece of work.
			lastHeartbeatAt: FIXED_NOW,
			endedAt: null
		});
	});

	it('records where the agent is running, which is what the rail shows', () => {
		const { session } = registerSession(h, {
			agentId,
			meta: { host: 'wildware', cwd: '/srv/app', model: 'opus' }
		});

		expect(findSessionById(h.db, session.id)!.meta).toEqual({
			host: 'wildware',
			cwd: '/srv/app',
			model: 'opus'
		});
	});

	it('keeps only the three fields the design names, so nothing unknown reaches a browser', () => {
		const { session } = registerSession(h, {
			agentId,
			meta: { host: 'box', secret: 'do not render me' }
		});

		expect(findSessionById(h.db, session.id)!.meta).toEqual({ host: 'box' });
	});

	it('stores no meta at all when the agent said nothing useful', () => {
		const { session } = registerSession(h, { agentId, meta: { host: '   ' } });

		expect(findSessionById(h.db, session.id)!.meta).toBeNull();
	});

	it('refuses meta that is not text, rather than storing a number as a host', () => {
		expect(
			refusalCode(() =>
				registerSession(h, { agentId, meta: { host: 42 } as unknown as SessionMeta })
			)
		).toBe('invalid_argument');
	});

	it('refuses an unknown agent', () => {
		expect(refusalCode(() => registerSession(h, { agentId: 'nobody' }))).toBe('not_found');
	});

	it('announces the agent as online, naming the session that made it so', () => {
		const { session } = registerSession(h, { agentId });

		expect(presenceEvents()).toEqual([{ agentId, sessionId: session.id, online: true }]);
	});

	it('says nothing when the agent is already online: a second run is not a transition', () => {
		registerSession(h, { agentId });
		registerSession(h, { agentId, meta: { host: 'second-box' } });

		expect(presenceEvents()).toHaveLength(1);
	});

	it('announces again once the agent had gone quiet past the window', () => {
		registerSession(h, { agentId });
		now += PRESENCE_WINDOW_MS + 1;

		registerSession(h, { agentId });

		expect(presenceEvents().map((event) => event.online)).toEqual([true, true]);
	});
});

describe('heartbeat', () => {
	it('moves the session forward, which is the whole of presence', () => {
		const { session } = registerSession(h, { agentId });
		now += 30_000;

		heartbeat(h, { sessionId: session.id, agentId });

		expect(findSessionById(h.db, session.id)!.lastHeartbeatAt).toBe(now);
	});

	it('piggybacks the counts an agent would otherwise poll three tools for', () => {
		const { session } = registerSession(h, { agentId });

		// Nothing is waiting for this agent, so every count is honestly zero —
		// and the shape an agent reads is the same one it reads when they are not.
		expect(heartbeat(h, { sessionId: session.id, agentId })).toEqual({
			ok: true,
			unreadMessages: 0,
			openTasks: 0,
			pendingApprovals: 0
		});
	});

	it('refuses a session that does not exist', () => {
		expect(refusalCode(() => heartbeat(h, { sessionId: 'nope', agentId }))).toBe('not_found');
	});

	it('refuses another agent’s session, so one agent cannot keep another alive', () => {
		const other = h.agent('intruder');
		const { session } = registerSession(h, { agentId });

		expect(refusalCode(() => heartbeat(h, { sessionId: session.id, agentId: other }))).toBe(
			'invalid_argument'
		);
	});

	it('tells an agent whose session was swept to register again', () => {
		const { session } = registerSession(h, { agentId });
		endSession(h, { sessionId: session.id, agentId });

		expect(refusalCode(() => heartbeat(h, { sessionId: session.id, agentId }))).toBe('conflict');
	});

	it('publishes nothing at all under a heartbeat storm', () => {
		const { session } = registerSession(h, { agentId });
		const before = h.events.length;

		for (let beat = 0; beat < 200; beat += 1) {
			now += 100;
			heartbeat(h, { sessionId: session.id, agentId });
		}

		// The one thing that must never happen: an SSE stream flooded by an agent
		// doing nothing but staying alive (design §4).
		expect(h.events.length).toBe(before);
	});

	it('announces a transition when the agent comes back from beyond the window', () => {
		const { session } = registerSession(h, { agentId });
		now += PRESENCE_WINDOW_MS + 1;

		heartbeat(h, { sessionId: session.id, agentId });

		expect(presenceEvents()).toEqual([
			{ agentId, sessionId: session.id, online: true },
			{ agentId, sessionId: session.id, online: true }
		]);
	});
});

describe('endSession', () => {
	it('closes the session and announces the agent as offline', () => {
		const { session } = registerSession(h, { agentId });

		const result = endSession(h, { sessionId: session.id, agentId });

		expect(result.ended).toBe(true);
		expect(result.session.endedAt).toBe(now);
		expect(presenceEvents().at(-1)).toEqual({ agentId, sessionId: session.id, online: false });
	});

	it('stays quiet while another session of the same agent is still beating', () => {
		const first = registerSession(h, { agentId }).session;
		registerSession(h, { agentId });

		endSession(h, { sessionId: first.id, agentId });

		expect(presenceEvents().map((event) => event.online)).toEqual([true]);
	});

	it('is idempotent, and the second call announces nothing', () => {
		const { session } = registerSession(h, { agentId });
		endSession(h, { sessionId: session.id, agentId });
		const events = h.events.length;

		expect(endSession(h, { sessionId: session.id, agentId }).ended).toBe(false);
		expect(h.events.length).toBe(events);
	});

	it('refuses an unknown session and another agent’s session', () => {
		const other = h.agent('intruder');
		const { session } = registerSession(h, { agentId });

		expect(refusalCode(() => endSession(h, { sessionId: 'nope', agentId }))).toBe('not_found');
		expect(refusalCode(() => endSession(h, { sessionId: session.id, agentId: other }))).toBe(
			'invalid_argument'
		);
	});
});

describe('presence is derived, never a stored flag', () => {
	it('is online while a heartbeat is inside the window and offline one millisecond past it', () => {
		registerSession(h, { agentId });

		now += PRESENCE_WINDOW_MS;
		expect(isAgentOnline(h, agentId)).toBe(true);

		now += 1;
		expect(isAgentOnline(h, agentId)).toBe(false);
	});

	it('reads offline for an agent that never registered', () => {
		expect(isAgentOnline(h, agentId)).toBe(false);
	});

	it('reads offline the moment a session is closed, however recent its heartbeat', () => {
		const { session } = registerSession(h, { agentId });

		endSession(h, { sessionId: session.id, agentId });

		expect(isAgentOnline(h, agentId)).toBe(false);
	});

	it('never writes a flag it could get wrong: the row only ever holds timestamps', () => {
		const { session } = registerSession(h, { agentId });
		const columns = Object.keys(
			h.db.prepare('SELECT * FROM sessions WHERE id = ?').get(session.id) as object
		);

		expect(columns).not.toContain('online');
	});
});

describe('listLiveAgents: what the right rail renders', () => {
	it('reports the agent with the session metadata the design asks for', () => {
		registerSession(h, {
			agentId,
			meta: { host: 'wildware', cwd: '/srv/ssd1/app', model: 'opus' }
		});

		expect(listLiveAgents(h)).toEqual([
			{
				agentId,
				name: 'scout',
				sessionId: expect.any(String),
				startedAt: FIXED_NOW,
				lastHeartbeatAt: FIXED_NOW,
				sessions: 1,
				host: 'wildware',
				cwd: '/srv/ssd1/app',
				model: 'opus'
			}
		]);
	});

	it('leaves the three fields null when the agent reported nothing', () => {
		registerSession(h, { agentId });

		expect(listLiveAgents(h)[0]).toMatchObject({ host: null, cwd: null, model: null });
	});

	it('puts the most recently heard-from agent first', () => {
		const quiet = h.agent('quiet');
		registerSession(h, { agentId: quiet });
		now += 1_000;
		registerSession(h, { agentId });

		expect(listLiveAgents(h).map((agent) => agent.name)).toEqual(['scout', 'quiet']);
	});

	it('lists an agent once however many runs it has, and counts them', () => {
		registerSession(h, { agentId, meta: { host: 'first' } });
		now += 1_000;
		registerSession(h, { agentId, meta: { host: 'second' } });

		expect(listLiveAgents(h)).toMatchObject([{ agentId, sessions: 2, host: 'second' }]);
	});

	it('drops an agent that has stopped beating, without anything having to close it', () => {
		registerSession(h, { agentId });

		now += PRESENCE_WINDOW_MS + 1;

		expect(listLiveAgents(h)).toEqual([]);
	});

	it('drops an agent whose session was ended', () => {
		const { session } = registerSession(h, { agentId });

		endSession(h, { sessionId: session.id, agentId });

		expect(listLiveAgents(h)).toEqual([]);
	});
});

describe('sweepSessions', () => {
	it('closes a session idle beyond the window and leaves a live one alone', () => {
		const stale = registerSession(h, { agentId }).session;
		const fresh = registerSession(h, { agentId: h.agent('busy') }).session;
		now += SESSION_IDLE_MS + 1;
		heartbeat(h, { sessionId: fresh.id, agentId: findSessionById(h.db, fresh.id)!.agentId });

		const result = sweepSessions(h);

		expect(result.closed).toEqual([stale.id]);
		expect(findSessionById(h.db, stale.id)!.endedAt).toBe(now);
		expect(findSessionById(h.db, fresh.id)!.endedAt).toBeNull();
	});

	it('closes nothing while every session is inside the window', () => {
		registerSession(h, { agentId });

		expect(sweepSessions(h)).toEqual({ closed: [], wentOffline: [] });
	});

	it('announces no transition for an agent the browser already renders as offline', () => {
		registerSession(h, { agentId });
		now += SESSION_IDLE_MS + 1;
		const before = h.events.length;

		sweepSessions(h);

		// It stopped counting as present nine minutes ago (90s window), so a
		// presence event here would announce something the browser already knows.
		expect(h.events.length).toBe(before);
	});

	it('announces offline when it closes a session that was still counted present', () => {
		const { session } = registerSession(h, { agentId });
		now += 1_000;

		// A deliberately short idle window, which is the only way a swept session
		// can also have been inside the 90s presence window.
		const result = sweepSessions(h, { idleMs: 500 });

		expect(result).toEqual({ closed: [session.id], wentOffline: [agentId] });
		expect(presenceEvents().at(-1)).toEqual({ agentId, sessionId: null, online: false });
	});

	it('leaves an agent alone when only one of its two sessions was stale', () => {
		insertSession(h.db, { agentId, startedAt: now - 1_000, lastHeartbeatAt: now - 1_000 });
		registerSession(h, { agentId });

		const result = sweepSessions(h, { idleMs: 500 });

		expect(result.closed).toHaveLength(1);
		expect(result.wentOffline).toEqual([]);
		expect(isAgentOnline(h, agentId)).toBe(true);
	});

	it('is what makes a gate against a dead agent fail loudly rather than hang', () => {
		const { session } = registerSession(h, { agentId });
		now += SESSION_IDLE_MS + 1;

		sweepSessions(h);

		// The session is gone, so the agent's next heartbeat is refused instead of
		// silently succeeding against a run nobody is watching.
		expect(listSessionsForAgent(h.db, agentId, { openOnly: true })).toEqual([]);
		expect(refusalCode(() => heartbeat(h, { sessionId: session.id, agentId }))).toBe('conflict');
	});
});

describe('startPresenceSweeper', () => {
	it('sweeps on its interval and stops when it is told to', () => {
		vi.useFakeTimers();
		try {
			const { session } = registerSession(h, { agentId });
			now += SESSION_IDLE_MS + 1;
			const stop = startPresenceSweeper({ context: () => h, intervalMs: 1_000 });

			vi.advanceTimersByTime(1_000);
			expect(findSessionById(h.db, session.id)!.endedAt).toBe(now);

			stop();
			const second = registerSession(h, { agentId }).session;
			now += SESSION_IDLE_MS + 1;
			vi.advanceTimersByTime(10_000);

			expect(findSessionById(h.db, second.id)!.endedAt).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it('survives a sweep that throws, because a failed tick must not kill the timer', () => {
		vi.useFakeTimers();
		const errors: unknown[] = [];
		try {
			const stop = startPresenceSweeper({
				context: () => {
					throw new Error('database is away');
				},
				intervalMs: 1_000,
				onError: (error) => errors.push(error)
			});

			vi.advanceTimersByTime(3_000);
			stop();

			expect(errors).toHaveLength(3);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('the piggybacked counts', () => {
	it('answers zero when nothing at all is waiting for the agent', () => {
		expect(countWork(h, agentId)).toEqual({
			unreadMessages: 0,
			openTasks: 0,
			pendingApprovals: 0
		});
	});

	it('needs one function per count and no reshaping of the response', () => {
		// This is the seam #11, #14 and #15 fill in: each replaces one entry in
		// WORK_COUNTERS, and neither `heartbeat` nor its result shape moves.
		expect(Object.keys(WORK_COUNTERS).sort()).toEqual([
			'openTasks',
			'pendingApprovals',
			'unreadMessages'
		]);

		const counted = countWork(h, agentId, {
			unreadMessages: () => 3,
			openTasks: (_ctx, id) => (id === agentId ? 2 : 0),
			pendingApprovals: () => 1
		});

		expect(counted).toEqual({ unreadMessages: 3, openTasks: 2, pendingApprovals: 1 });
	});
});

describe('the heartbeat counts what is waiting on the owner (#15)', () => {
	it('reports this agent’s pending requests, and nobody else’s', () => {
		const { session } = registerSession(h, { agentId });
		const other = h.agent('scout-15');
		createRequest(h, { agentId, kind: 'confirm', question: 'push?' });
		createRequest(h, { agentId, kind: 'text', question: 'commit message?' });
		createRequest(h, { agentId: other, kind: 'confirm', question: 'mine?' });

		expect(heartbeat(h, { sessionId: session.id, agentId }).pendingApprovals).toBe(2);
		expect(countWork(h, other).pendingApprovals).toBe(1);
	});

	it('stops counting a request the owner has answered', () => {
		const { request } = createRequest(h, { agentId, kind: 'confirm', question: 'push?' });

		answerRequest(h, { requestId: request.id, value: true });

		expect(countWork(h, agentId).pendingApprovals).toBe(0);
	});
});
