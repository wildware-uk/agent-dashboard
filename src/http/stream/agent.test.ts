import { describe, expect, it } from 'vitest';
import {
	broadcastTask,
	createTask,
	postMessage,
	postUpdate,
	createProject,
	readMessages
} from '$domain';
import { mcpHarness, type McpHarness } from '../../mcp/testing';
import { createTokenRateLimiter } from '$mcp';
import { createAgentStreamHandler } from './agent';

/**
 * The agent's own stream (design §4, §5).
 *
 * Two things are being asserted, and they pull in opposite directions. It has
 * to be *live* — the whole point is that a reply reaches a working agent
 * without waiting for its next heartbeat — and it has to be *narrow*: a bearer
 * token is not the owner's cookie, and an agent must never be handed another
 * agent's work or the deployment's event log.
 */

type Frame = { event?: string; data?: Record<string, unknown>; comment?: string; retry?: number };

function parseFrames(text: string): Frame[] {
	return text
		.split('\n\n')
		.filter((block) => block.trim().length > 0)
		.map((block) => {
			const frame: Frame = {};
			for (const line of block.split('\n')) {
				if (line.startsWith(': ')) frame.comment = line.slice(2);
				else if (line.startsWith('event: ')) frame.event = line.slice(7);
				else if (line.startsWith('retry: ')) frame.retry = Number(line.slice(7));
				else if (line.startsWith('data: ')) frame.data = JSON.parse(line.slice(6));
			}
			return frame;
		});
}

/** Open the stream as the agent holding `token`, and read frames off it. */
function connect(mcp: McpHarness, token: string = mcp.token, query = '') {
	const handler = createAgentStreamHandler({
		bus: mcp.h.bus,
		context: () => mcp.h,
		config: () => ({ tokenSecret: mcp.secret, holdMs: 1_000 }),
		rateLimiter: createTokenRateLimiter(),
		heartbeatMs: 0
	});

	const abort = new AbortController();
	const response = handler({
		request: new Request(`http://dash.test/api/agent/stream${query}`, {
			headers: { authorization: `Bearer ${token}` },
			signal: abort.signal
		})
	});

	const decoder = new TextDecoder();
	// Lazily, so a refusal's body is still readable as JSON: `getReader()` locks
	// it, and a 401 is asserted by reading the body rather than streaming it.
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	// Kept across calls: `take(4)` means "four frames so far", not "four more".
	let buffered = '';

	return {
		response,
		abort,
		/** Read until `count` frames have arrived. Every write is synchronous. */
		async take(count: number): Promise<Frame[]> {
			reader ??= response.body!.getReader();
			let frames = parseFrames(buffered);
			while (frames.length < count) {
				const chunk = await reader.read();
				if (chunk.done) break;
				buffered += decoder.decode(chunk.value);
				frames = parseFrames(buffered);
			}
			return frames;
		}
	};
}

/** Just the `work` frames, so a message frame between them shifts no index. */
function workFrames(frames: Frame[]): Frame[] {
	return frames.filter((frame) => frame.event === 'work');
}

/** The message bodies one `message` frame carries. */
function bodiesOf(frame: Frame | undefined): string[] {
	return ((frame?.data?.messages ?? []) as { body: string }[]).map((message) => message.body);
}

/** The counts off a `work` frame, in the order a heartbeat reports them. */
function counts(frame: Frame): [number, number, number] {
	return [
		frame.data?.unread_messages as number,
		frame.data?.open_tasks as number,
		frame.data?.pending_approvals as number
	];
}

describe('who may open it', () => {
	it('refuses a request with no token, the way /mcp does', async () => {
		const mcp = mcpHarness();
		const { response } = connect(mcp, '');

		expect(response.status).toBe(401);
		expect(((await response.json()) as { error: string }).error).toBe('missing_token');
	});

	it('refuses a token this deployment never issued', async () => {
		const mcp = mcpHarness();
		const other = mcpHarness();
		const { response } = connect(mcp, other.token);

		expect(response.status).toBe(401);
	});

	it('refuses everybody when the deployment has no TOKEN_SECRET', async () => {
		const mcp = mcpHarness();
		const handler = createAgentStreamHandler({
			bus: mcp.h.bus,
			context: () => mcp.h,
			config: () => null,
			heartbeatMs: 0
		});

		const response = handler({
			request: new Request('http://dash.test/api/agent/stream', {
				headers: { authorization: `Bearer ${mcp.token}` }
			})
		});

		// Fails closed: with no secret there is no way to verify a token, so the
		// stream is refused rather than opened to an unauthenticated caller.
		expect(response.status).toBe(503);
	});
});

describe('what it pushes', () => {
	it('opens with the counts as they stand, so a reconnect needs no replay', async () => {
		const mcp = mcpHarness();
		const stream = connect(mcp);

		const frames = await stream.take(3);
		stream.abort.abort();

		expect(frames[0]?.retry).toBe(2_000);
		expect(frames[1]?.comment).toBe('connected');
		expect(frames[2]?.event).toBe('work');
		expect(counts(frames[2]!)).toEqual([0, 0, 0]);
	});

	it('pushes a task the moment it is created for this agent', async () => {
		const mcp = mcpHarness();
		const { project } = createProject(mcp.h, { name: 'Dashboard' });
		const stream = connect(mcp);
		await stream.take(3);

		createTask(mcp.h, {
			project: project.slug,
			title: 'ship the channel',
			agentId: mcp.deps.agent.id
		});

		const frames = await stream.take(4);
		stream.abort.abort();

		expect(frames[3]?.event).toBe('work');
		expect(counts(frames[3]!)).toEqual([0, 1, 0]);
	});

	it('pushes a reply the owner types, which is the latency this exists for', async () => {
		const mcp = mcpHarness();
		const { project } = createProject(mcp.h, { name: 'Dashboard' });
		const stream = connect(mcp);
		await stream.take(3);

		postMessage(mcp.h, {
			project: project.slug,
			author: { kind: 'human' },
			body: 'try the other branch'
		});

		const frames = await stream.take(5);
		stream.abort.abort();

		expect(counts(workFrames(frames).at(-1)!)).toEqual([1, 0, 0]);

		// And the message itself rides along, so the agent can judge it without a
		// tool call: the text, the ids, and which project it is about.
		const message = frames.find((frame) => frame.event === 'message');
		const [first] = (message?.data?.messages ?? []) as Record<string, unknown>[];
		expect(first).toMatchObject({
			body: 'try the other branch',
			project: project.slug,
			project_name: project.name,
			author: 'human'
		});
		expect(first?.message_id).toEqual(expect.any(String));
	});

	it('says nothing when the counts have not moved', async () => {
		const mcp = mcpHarness();
		const { project } = createProject(mcp.h, { name: 'Dashboard' });
		const stream = connect(mcp);
		await stream.take(3);

		// Another agent's task is not this agent's work, so nothing is pushed —
		// a bearer token is not a licence to watch the deployment.
		const other = mcp.mint('other-agent');
		createTask(mcp.h, {
			project: project.slug,
			title: 'not yours',
			agentId: other.agentId
		});
		// This one is, and it is the frame that proves the stream was live all
		// along rather than merely quiet.
		createTask(mcp.h, {
			project: project.slug,
			title: 'yours',
			agentId: mcp.deps.agent.id
		});

		const frames = await stream.take(4);
		stream.abort.abort();

		expect(frames).toHaveLength(4);
		expect(counts(frames[3]!)).toEqual([0, 1, 0]);
	});

	/**
	 * The bug the first live run found.
	 *
	 * Reading messages moves the agent's cursor, which lowers `unread_messages`
	 * — but nothing published that, so the stream stayed silent and every
	 * listener kept a stale figure. The next real message then looked like a
	 * *fall* against it and was suppressed as "the agent clearing its own inbox".
	 * A count that changes without a frame is the one thing this stream cannot do.
	 */
	it('reports the drop when the agent reads its own messages', async () => {
		const mcp = mcpHarness();
		const { project } = createProject(mcp.h, { name: 'Dashboard' });
		const stream = connect(mcp);
		await stream.take(3);

		postMessage(mcp.h, { project: project.slug, author: { kind: 'human' }, body: 'one' });
		const afterMessage = await stream.take(5);
		expect(counts(workFrames(afterMessage).at(-1)!)).toEqual([1, 0, 0]);

		readMessages(mcp.h, { agentId: mcp.deps.agent.id });

		const afterRead = await stream.take(6);
		stream.abort.abort();

		// Without this frame nothing downstream can know the inbox is empty again.
		expect(counts(workFrames(afterRead).at(-1)!)).toEqual([0, 0, 0]);
	});

	/**
	 * The complaint that prompted this: agents woken by projects they have
	 * nothing to do with.
	 *
	 * There is no membership in this product, so relevance is derived from what
	 * an agent has actually done. A message in a project it has never touched is
	 * not its business and must not reach it — while `heartbeat` keeps answering
	 * "anything for me anywhere", which is a different question.
	 */
	it('ignores messages in projects this agent has nothing to do with', async () => {
		const mcp = mcpHarness();
		const { project: mine } = createProject(mcp.h, { name: 'Mine' });
		const { project: theirs } = createProject(mcp.h, { name: 'Theirs' });
		// Working in `mine` is what makes it this agent's: an update it posted.
		postUpdate(mcp.h, { project: mine.slug, agentId: mcp.deps.agent.id, body: 'working here' });

		const stream = connect(mcp);
		await stream.take(3);

		postMessage(mcp.h, { project: theirs.slug, author: { kind: 'human' }, body: 'not for you' });
		postMessage(mcp.h, { project: mine.slug, author: { kind: 'human' }, body: 'this one is' });

		const frames = await stream.take(5);
		stream.abort.abort();

		// One rise, not two: the other project's message never counted.
		expect(counts(workFrames(frames).at(-1)!)).toEqual([1, 0, 0]);
		const message = frames.find((frame) => frame.event === 'message');
		const bodies = ((message?.data?.messages ?? []) as { body: string }[]).map((m) => m.body);
		expect(bodies).toEqual(['this one is']);
	});

	/**
	 * The complaint the derived rule could not answer: an agent that has worked in
	 * two projects still hears both, and a session dedicated to one of them has no
	 * business being woken by the other. Only the session can say what it is for.
	 */
	it('honours an explicit subscription over what the agent has done before', async () => {
		const mcp = mcpHarness();
		const { project: merge } = createProject(mcp.h, { name: 'Megamerge' });
		const { project: dash } = createProject(mcp.h, { name: 'Dashboard' });
		// This agent genuinely works in both, so the derived rule would allow both.
		postUpdate(mcp.h, { project: merge.slug, agentId: mcp.deps.agent.id, body: 'merging' });
		postUpdate(mcp.h, { project: dash.slug, agentId: mcp.deps.agent.id, body: 'dashboarding' });

		const stream = connect(mcp, mcp.token, `?project=${merge.slug}`);
		await stream.take(3);

		postMessage(mcp.h, { project: dash.slug, author: { kind: 'human' }, body: 'about the dash' });
		postMessage(mcp.h, { project: merge.slug, author: { kind: 'human' }, body: 'about the merge' });

		const frames = await stream.take(5);
		stream.abort.abort();

		expect(counts(workFrames(frames).at(-1)!)).toEqual([1, 0, 0]);
		const message = frames.find((frame) => frame.event === 'message');
		const bodies = ((message?.data?.messages ?? []) as { body: string }[]).map((m) => m.body);
		expect(bodies).toEqual(['about the merge']);
	});

	it('takes several projects, for a session that spans two', async () => {
		const mcp = mcpHarness();
		const { project: one } = createProject(mcp.h, { name: 'One' });
		const { project: two } = createProject(mcp.h, { name: 'Two' });
		const { project: three } = createProject(mcp.h, { name: 'Three' });

		const stream = connect(mcp, mcp.token, `?project=${one.slug},${two.slug}`);
		await stream.take(3);

		postMessage(mcp.h, { project: three.slug, author: { kind: 'human' }, body: 'not mine' });
		postMessage(mcp.h, { project: two.slug, author: { kind: 'human' }, body: 'mine' });

		const frames = await stream.take(5);
		stream.abort.abort();

		expect(counts(workFrames(frames).at(-1)!)).toEqual([1, 0, 0]);
	});

	it('refuses a project that does not exist rather than carrying nothing', async () => {
		const mcp = mcpHarness();

		// A typo scoped to nothing looks exactly like a quiet dashboard, which is
		// the worst failure this surface can have. Better a loud 404 in the log.
		const { response } = connect(mcp, mcp.token, '?project=no-such-project');

		expect(response.status).toBe(404);
	});

	it('hears everything until it has worked anywhere, so a new agent is not deaf', async () => {
		const mcp = mcpHarness();
		const { project } = createProject(mcp.h, { name: 'Somewhere' });
		const stream = connect(mcp);
		await stream.take(3);

		// This agent has posted nothing and holds no tasks, so nothing is "its"
		// project yet. The first message ever sent to it still has to arrive.
		postMessage(mcp.h, { project: project.slug, author: { kind: 'human' }, body: 'hello' });

		const frames = await stream.take(5);
		stream.abort.abort();

		expect(counts(workFrames(frames).at(-1)!)).toEqual([1, 0, 0]);
	});

	it('sends absolute counts, so a missed frame repairs itself', async () => {
		const mcp = mcpHarness();
		const { project } = createProject(mcp.h, { name: 'Dashboard' });
		const stream = connect(mcp);
		await stream.take(3);

		postMessage(mcp.h, { project: project.slug, author: { kind: 'human' }, body: 'one' });
		postMessage(mcp.h, { project: project.slug, author: { kind: 'human' }, body: 'two' });

		const frames = await stream.take(7);
		stream.abort.abort();

		// Not two frames each saying "+1": each frame is the whole truth, which is
		// what makes dropping one harmless.
		const work = workFrames(frames);
		expect(counts(work[1]!)).toEqual([1, 0, 0]);
		expect(counts(work[2]!)).toEqual([2, 0, 0]);
	});
});

describe('letting go', () => {
	it('unsubscribes from the bus when the agent disconnects', async () => {
		const mcp = mcpHarness();
		const { project } = createProject(mcp.h, { name: 'Dashboard' });
		const stream = connect(mcp);
		await stream.take(3);

		stream.abort.abort();

		// A write after teardown would throw on a closed controller; the point is
		// that publishing costs nothing once nobody is listening.
		expect(() =>
			postMessage(mcp.h, { project: project.slug, author: { kind: 'human' }, body: 'nobody home' })
		).not.toThrow();
	});
});

describe('work broadcast to a project', () => {
	it('wakes an agent that works the project, without the task being assigned to it', async () => {
		const mcp = mcpHarness();
		const { project } = createProject(mcp.h, { name: 'Dashboard' });
		// A history in this project, so it is one the agent works in.
		postUpdate(mcp.h, { project: project.slug, agentId: mcp.deps.agent.id, body: 'here' });
		const task = createTask(mcp.h, { project: project.slug, title: 'anybody?' });
		const stream = connect(mcp);
		await stream.take(3);

		broadcastTask(mcp.h, task.id);

		const frames = await stream.take(4);
		stream.abort.abort();

		expect(counts(frames[3]!)).toEqual([0, 1, 0]);
	});

	it('stays quiet for a session that named other projects', async () => {
		const mcp = mcpHarness();
		const { project } = createProject(mcp.h, { name: 'Dashboard' });
		const { project: elsewhere } = createProject(mcp.h, { name: 'Elsewhere' });
		postUpdate(mcp.h, { project: project.slug, agentId: mcp.deps.agent.id, body: 'here' });
		const task = createTask(mcp.h, { project: project.slug, title: 'anybody?' });
		// Subscribed to the *other* project: a broadcast here is not this session's.
		const stream = connect(mcp, mcp.token, `?project=${elsewhere.slug}`);
		await stream.take(3);

		broadcastTask(mcp.h, task.id);
		// A task assigned by name still lands, whatever the session said it is for.
		createTask(mcp.h, {
			project: project.slug,
			title: 'yours by name',
			agentId: mcp.deps.agent.id
		});

		const frames = await stream.take(4);
		stream.abort.abort();

		expect(frames).toHaveLength(4);
		expect(counts(frames[3]!)).toEqual([0, 1, 0]);
	});
});

/**
 * `?project=*` — every project, asked for on purpose.
 *
 * The bridge now refuses to start without a subscription, so this is what a
 * general-purpose session sends. It is deliberately *wider* than the derived
 * rule: derived scope is whatever the agent's own history happens to be, and a
 * session that says `*` is saying it wants the deployment, including projects
 * this agent has never been near.
 */
describe('subscribing to everything', () => {
	it('carries a project this agent has never touched', async () => {
		const mcp = mcpHarness();
		const { project: mine } = createProject(mcp.h, { name: 'Mine' });
		const { project: theirs } = createProject(mcp.h, { name: 'Theirs' });
		// A history in one project only: the derived rule would scope to it.
		postUpdate(mcp.h, { project: mine.slug, agentId: mcp.deps.agent.id, body: 'here' });

		const stream = connect(mcp, mcp.token, '?project=*');
		await stream.take(3);

		postMessage(mcp.h, { project: theirs.slug, author: { kind: 'human' }, body: 'over here' });

		const frames = await stream.take(5);
		stream.abort.abort();

		expect(counts(workFrames(frames).at(-1)!)).toEqual([1, 0, 0]);
		const message = frames.find((frame) => frame.event === 'message');
		const bodies = ((message?.data?.messages ?? []) as { body: string }[]).map((m) => m.body);
		expect(bodies).toEqual(['over here']);
	});

	it('carries broadcast work from a project this agent has never touched', async () => {
		const mcp = mcpHarness();
		const { project: mine } = createProject(mcp.h, { name: 'Mine' });
		const { project: theirs } = createProject(mcp.h, { name: 'Theirs' });
		postUpdate(mcp.h, { project: mine.slug, agentId: mcp.deps.agent.id, body: 'here' });
		const task = createTask(mcp.h, { project: theirs.slug, title: 'anybody?' });

		const stream = connect(mcp, mcp.token, '?project=*');
		await stream.take(3);

		broadcastTask(mcp.h, task.id);

		const frames = await stream.take(4);
		stream.abort.abort();

		expect(counts(frames[3]!)).toEqual([0, 1, 0]);
	});

	it('refuses the wildcard beside a slug, because the caller cannot have meant both', async () => {
		const mcp = mcpHarness();
		const { project } = createProject(mcp.h, { name: 'Dashboard' });

		const { response } = connect(mcp, mcp.token, `?project=*,${project.slug}`);

		expect(response.status).toBe(400);
	});
});

/**
 * The complaint that would not go away: "it sends them all every time I send
 * one".
 *
 * The message frame used to carry the *unread set*, recomputed from the read
 * cursor on every rise — and the cursor only moves when the agent calls
 * `get_messages`. So a second message re-announced the first, a third
 * re-announced both, and an owner typing five lines interrupted the agent
 * fifteen times with five things.
 *
 * The bridge learned to remember what it had said, which fixed it for a bridge
 * running today's code. This is the same rule one layer down, where every
 * client gets it: a long-lived session started days ago is still holding the
 * process it was launched with, and the fix has to reach that one too.
 */
describe('saying each message once', () => {
	it('does not re-announce a message the agent has already been told about', async () => {
		const mcp = mcpHarness();
		const { project } = createProject(mcp.h, { name: 'Dashboard' });
		const stream = connect(mcp, mcp.token, `?project=${project.slug}`);
		await stream.take(3);

		postMessage(mcp.h, { project: project.slug, author: { kind: 'human' }, body: 'first' });
		const afterFirst = await stream.take(5);
		expect(bodiesOf(afterFirst.filter((frame) => frame.event === 'message').at(-1))).toEqual([
			'first'
		]);

		// Still unread — nothing has called `get_messages` — so the unread set now
		// holds both, and the naive frame would carry both.
		postMessage(mcp.h, { project: project.slug, author: { kind: 'human' }, body: 'second' });
		const afterSecond = await stream.take(7);
		stream.abort.abort();

		const messages = afterSecond.filter((frame) => frame.event === 'message');
		expect(bodiesOf(messages.at(-1))).toEqual(['second']);
		// Two arrivals, two frames, two announcements in total.
		expect(messages.flatMap((frame) => bodiesOf(frame))).toEqual(['first', 'second']);
	});

	it('still opens a fresh connection with what is waiting', async () => {
		const mcp = mcpHarness();
		const { project } = createProject(mcp.h, { name: 'Dashboard' });
		postMessage(mcp.h, {
			project: project.slug,
			author: { kind: 'human' },
			body: 'while you were out'
		});

		// A reconnect is a new connection and knows nothing of what the last one
		// said, which is the right way round: the alternative is an agent that
		// reconnects into silence with an inbox it never hears about.
		const stream = connect(mcp, mcp.token, `?project=${project.slug}`);
		const frames = await stream.take(4);
		stream.abort.abort();

		expect(bodiesOf(frames.find((frame) => frame.event === 'message'))).toEqual([
			'while you were out'
		]);
	});
});
