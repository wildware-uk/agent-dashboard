import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { endSession, heartbeat, registerSession, sweepSessions } from '$domain';
import { harness, type Harness } from '$domain/testing';
import { PRESENCE_WINDOW_MS, Presence } from '$web';
import { FakeStream } from '$web/testing';
import { SESSION_COOKIE, signSession } from '../auth';
import { readAgentsSnapshot } from './agents';
import { createSnapshotHandler } from './snapshot';

/**
 * The acceptance criteria of the sessions slice, joined up: an agent that
 * registers and beats appears in a browser that was already open, and drops out
 * of it when it stops.
 *
 * Everything below the browser is real — the domain, the bus, the presence
 * derivation and the snapshot endpoint, all over one in-memory database. The two
 * fakes are the two things a Node test cannot have: `EventSource` (the bus is
 * piped into a `FakeStream`, exactly as `GET /api/stream` pipes it into a real
 * one) and the network (`fetch` calls the snapshot handler directly).
 *
 * What is under test is therefore the join, which no unit test can cover: a
 * write publishes a transition, the stream carries it, and the rail that was
 * only watching agrees — and, for the offline direction, agrees *without* any
 * event at all, because going quiet is the absence of one.
 */

const SESSION_SECRET = 's'.repeat(32);
const config = () => ({ sessionSecret: SESSION_SECRET, adminPasswordHash: '$argon2id$x' });
const cookies = {
	get: (name: string) => (name === SESSION_COOKIE ? signSession(SESSION_SECRET) : undefined)
};

let h: Harness;
let now: number;
let agentId: string;
let queue: (() => void)[];
let stream: FakeStream;
/** Every frame the stream carried, so a heartbeat storm can be counted. */
let frames: string[];
let rail: Presence;

function snapshotFetch(url: string): Promise<Response> {
	const target = new URL(url, 'http://dash.test');
	const handler = createSnapshotHandler({ read: () => readAgentsSnapshot(h), config, bus: h.bus });
	return Promise.resolve(handler({ request: new Request(target), url: target, cookies }));
}

/** One open browser tab, watching presence. */
function tab(): Presence {
	stream = new FakeStream();
	frames = [];
	// The stream route is a subscription plus a serialisation, and nothing else
	// (design §4), so this is the whole of it.
	h.bus.subscribe((event) => {
		frames.push(event.type);
		stream.emit(event.type, { seq: event.seq, payload: event.payload });
	});

	const presence = new Presence({
		fetch: snapshotFetch,
		openStream: () => stream,
		schedule: (run) => queue.push(run),
		clock: () => now,
		tickMs: 5,
		pollMs: 60_000
	});
	presence.start();
	return presence;
}

async function settle(): Promise<void> {
	for (let pass = 0; pass < 5; pass += 1) {
		while (queue.length > 0) queue.shift()!();
		await Promise.resolve();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

beforeEach(async () => {
	now = Date.UTC(2026, 7, 25, 10, 0, 0);
	h = harness({ now: () => now });
	agentId = h.agent('scout');
	queue = [];
	rail = tab();
	await settle();
});

afterEach(() => {
	rail.stop();
});

describe('an agent coming online', () => {
	it('appears on a rail that was already open, with its session metadata', async () => {
		expect(rail.online).toEqual([]);

		registerSession(h, { agentId, meta: { host: 'wildware', cwd: '/srv/app', model: 'opus' } });
		await settle();

		expect(rail.online).toMatchObject([
			{ name: 'scout', host: 'wildware', cwd: '/srv/app', model: 'opus', sessions: 1 }
		]);
	});

	it('stays on the rail while it keeps beating, and the stream stays silent', async () => {
		const { session } = registerSession(h, { agentId });
		await settle();
		frames.length = 0;

		for (let beat = 0; beat < 30; beat += 1) {
			now += 20_000;
			heartbeat(h, { sessionId: session.id, agentId });
			await settle();
		}
		// What the rail's periodic poll does. It has to be the poll and not an
		// event: ten minutes of healthy beating publishes nothing at all, which is
		// the whole point of transitions-only (design §4).
		await rail.refresh();

		expect(frames).toEqual([]);
		expect(rail.online).toHaveLength(1);
	});

	it('keeps its heartbeat time fresh through the periodic read', async () => {
		const { session } = registerSession(h, { agentId });
		await settle();

		now += 60_000;
		heartbeat(h, { sessionId: session.id, agentId });
		// No event was published, so this is the poll's job: without it the rail
		// would hold a heartbeat time that aged out while the agent was alive.
		await rail.refresh();

		expect(rail.online[0].lastHeartbeatAt).toBe(now);
	});
});

describe('an agent going offline', () => {
	it('drops off the rail once it stops beating, with no event to say so', async () => {
		registerSession(h, { agentId });
		await settle();
		frames.length = 0;

		now += PRESENCE_WINDOW_MS + 1;

		await vi.waitFor(() => expect(rail.online).toEqual([]));
		expect(frames).toEqual([]);
	});

	it('goes at once when it ends its session, rather than after the window', async () => {
		const { session } = registerSession(h, { agentId });
		await settle();

		frames.length = 0;

		endSession(h, { sessionId: session.id, agentId });
		await settle();

		expect(frames).toEqual(['agent.presence']);
		expect(rail.online).toEqual([]);
	});

	it('is swept without disturbing a rail that already showed it as gone', async () => {
		const { session } = registerSession(h, { agentId });
		await settle();
		now += PRESENCE_WINDOW_MS + 1;
		await vi.waitFor(() => expect(rail.online).toEqual([]));
		frames.length = 0;

		now += 10 * 60_000;
		const swept = sweepSessions(h);
		await settle();

		expect(swept.closed).toEqual([session.id]);
		// Nothing to announce: the rail had derived this nine minutes ago.
		expect(frames).toEqual([]);
		expect(rail.online).toEqual([]);
	});
});

describe('two agents', () => {
	it('shows both, most recently heard from first', async () => {
		const other = h.agent('runner');
		registerSession(h, { agentId: other, meta: { host: 'laptop' } });
		now += 1_000;
		registerSession(h, { agentId, meta: { host: 'wildware' } });
		await settle();

		expect(rail.online.map((agent) => agent.name)).toEqual(['scout', 'runner']);
	});

	it('drops only the one that went quiet', async () => {
		const other = h.agent('runner');
		const quiet = registerSession(h, { agentId: other }).session;
		const busy = registerSession(h, { agentId }).session;
		await settle();

		now += PRESENCE_WINDOW_MS;
		heartbeat(h, { sessionId: busy.id, agentId });
		await rail.refresh();
		now += 1;

		await vi.waitFor(() => expect(rail.online.map((agent) => agent.name)).toEqual(['scout']));
		expect(quiet.agentId).toBe(other);
	});
});
