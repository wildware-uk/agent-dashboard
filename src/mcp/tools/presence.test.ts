/**
 * The three presence tools, driven as an agent's run would drive them
 * (design §5): register once, beat while working, end when finished.
 *
 * They share a test file because they share a subject — one session's life — and
 * the interesting assertions are about the sequence rather than about any one
 * call.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { HEARTBEAT_INTERVAL_S, isAgentOnline, listAgents, listLiveAgents } from '$domain';
import { mcpHarness, toolText, type McpHarness } from '../testing';
import { endSessionTool } from './end-session';
import { heartbeatTool } from './heartbeat';
import { registerSessionTool } from './register-session';

let mcp: McpHarness;
beforeEach(() => {
	mcp = mcpHarness({ name: 'scout' });
});

const register = (args: Parameters<typeof registerSessionTool.run>[1] = {}) =>
	registerSessionTool.run(mcp.deps, args);
const beat = (args: Parameters<typeof heartbeatTool.run>[1]) => heartbeatTool.run(mcp.deps, args);
const finish = (args: Parameters<typeof endSessionTool.run>[1]) =>
	endSessionTool.run(mcp.deps, args);

/** The `session_id` a successful register handed back. */
function sessionId(): string {
	const result = register({ meta: { host: 'wildware', cwd: '/srv/app', model: 'opus' } });
	return (result.structuredContent as { session_id: string }).session_id;
}

describe('register_session', () => {
	it('returns the session and the interval the agent should beat at', () => {
		const result = register({ meta: { host: 'wildware', cwd: '/srv/app', model: 'opus' } });

		expect(result.isError).toBeUndefined();
		expect(result.structuredContent).toEqual({
			session_id: expect.any(String),
			heartbeat_interval_s: HEARTBEAT_INTERVAL_S
		});
	});

	it('needs no arguments at all: an agent that knows nothing about itself can register', () => {
		const result = register();

		expect(result.isError).toBeUndefined();
		expect(isAgentOnline(mcp.h, mcp.deps.agent.id)).toBe(true);
	});

	it('puts the run on the rail with the metadata it reported', () => {
		register({ meta: { host: 'wildware', cwd: '/srv/app', model: 'opus' } });

		expect(listLiveAgents(mcp.h)).toMatchObject([
			{ name: 'scout', host: 'wildware', cwd: '/srv/app', model: 'opus' }
		]);
	});

	it('announces the agent online exactly once', () => {
		register();
		register();

		expect(mcp.h.eventNames()).toEqual(['agent.presence']);
	});

	it('says in words how often to beat, because that sentence is what the model reads', () => {
		expect(toolText(register())).toContain(`${HEARTBEAT_INTERVAL_S}`);
	});

	it('refuses meta that is too long rather than truncating it', () => {
		const result = register({ meta: { host: 'h'.repeat(500) } });

		expect(result.isError).toBe(true);
		expect(toolText(result)).toContain('invalid_argument');
	});
});

describe('heartbeat', () => {
	it('answers with the piggybacked counts, so no agent has to poll for work', () => {
		const session_id = sessionId();

		const result = beat({ session_id });

		expect(result.isError).toBeUndefined();
		expect(result.structuredContent).toEqual({
			ok: true,
			unread_messages: 0,
			open_tasks: 0,
			pending_approvals: 0
		});
	});

	it('publishes nothing while the agent is already online', () => {
		const session_id = sessionId();
		mcp.h.events.length = 0;

		for (let n = 0; n < 20; n += 1) beat({ session_id });

		expect(mcp.h.events).toEqual([]);
	});

	it('reports an unknown session as not_found, which tells the agent to register', () => {
		const result = beat({ session_id: 'no-such-session' });

		expect(result.isError).toBe(true);
		expect(toolText(result)).toContain('not_found');
	});

	it('will not let one agent beat for another', () => {
		const session_id = sessionId();
		// Same deployment, a different token: exactly the case §5 exists to stop.
		const minted = mcp.mint('intruder');
		const intruder = listAgents(mcp.h).find((agent) => agent.id === minted.agentId)!;

		const result = heartbeatTool.run({ ctx: mcp.h, agent: intruder }, { session_id });

		expect(result.isError).toBe(true);
		expect(toolText(result)).toContain('invalid_argument');
	});

	it('reports a session that has ended as a conflict', () => {
		const session_id = sessionId();
		finish({ session_id });

		const result = beat({ session_id });

		expect(result.isError).toBe(true);
		expect(toolText(result)).toContain('conflict');
		expect(toolText(result)).toContain('register_session');
	});
});

describe('end_session', () => {
	it('closes the run and takes the agent off the rail', () => {
		const session_id = sessionId();

		const result = finish({ session_id });

		expect(result.structuredContent).toEqual({ session_id, ended: true });
		expect(listLiveAgents(mcp.h)).toEqual([]);
	});

	it('is safe to call twice, and says which call did the work', () => {
		const session_id = sessionId();
		finish({ session_id });

		expect(finish({ session_id }).structuredContent).toEqual({ session_id, ended: false });
	});

	it('reports an unknown session rather than pretending it closed one', () => {
		const result = finish({ session_id: 'nope' });

		expect(result.isError).toBe(true);
		expect(toolText(result)).toContain('not_found');
	});

	it("will not let one agent end another's run", () => {
		const session_id = sessionId();
		const minted = mcp.mint('intruder');
		const intruder = listAgents(mcp.h).find((agent) => agent.id === minted.agentId)!;

		const result = endSessionTool.run({ ctx: mcp.h, agent: intruder }, { session_id });

		expect(result.isError).toBe(true);
		expect(toolText(result)).toContain('invalid_argument');
		// And the run really is still open, rather than merely reported as such.
		expect(listLiveAgents(mcp.h)).toHaveLength(1);
	});
});

/**
 * Issue #21: an agent cannot handle an error it was never told about, so every
 * code a session tool can hand back has to appear in the description the agent
 * reads. The lists below are the codes exercised by the tests above.
 */
describe('the session tools document every code they can fail with', () => {
	const documented: ReadonlyArray<[string, string, readonly string[]]> = [
		['heartbeat', heartbeatTool.config.description, ['not_found', 'invalid_argument', 'conflict']],
		['end_session', endSessionTool.config.description, ['not_found', 'invalid_argument']]
	];

	it.each(documented)('%s names each one', (name, description, codes) => {
		for (const code of codes) expect(description, `${name}: ${code}`).toContain(code);
	});

	it("says what to do about another agent's session where the code is named", () => {
		for (const [name, description] of documented) {
			// Read as one paragraph: the wrapping is an artefact of the source, and
			// what matters is that the explanation sits next to the code itself.
			const prose = description.replace(/\s+/g, ' ');
			const at = prose.indexOf('"invalid_argument"');
			expect(at, name).toBeGreaterThan(-1);
			expect(prose.slice(at, at + 200), name).toContain('another agent');
		}
	});
});

describe('the presence tools as a set', () => {
	it('publishes one event to come online and one to go offline, and nothing between', () => {
		const session_id = sessionId();
		for (let n = 0; n < 10; n += 1) beat({ session_id });
		finish({ session_id });

		expect(mcp.h.eventNames()).toEqual(['agent.presence', 'agent.presence']);
		expect(mcp.h.events.map((event) => (event.payload as { online: boolean }).online)).toEqual([
			true,
			false
		]);
	});
});
