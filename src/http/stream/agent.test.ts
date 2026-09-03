import { describe, expect, it } from 'vitest';
import {
	answerRequest,
	broadcastTask,
	react,
	cancelRequest,
	createRequest,
	createTask,
	deliveriesFor,
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

	it('opens a fresh connection with what has never been delivered', async () => {
		const mcp = mcpHarness();
		const { project } = createProject(mcp.h, { name: 'Dashboard' });
		postMessage(mcp.h, {
			project: project.slug,
			author: { kind: 'human' },
			body: 'while you were out'
		});

		const stream = connect(mcp, mcp.token, `?project=${project.slug}`);
		const frames = await stream.take(4);
		stream.abort.abort();

		expect(bodiesOf(frames.find((frame) => frame.event === 'message'))).toEqual([
			'while you were out'
		]);
	});

	/**
	 * The regression that took a live session silent.
	 *
	 * Every session here shares one bearer token, so they are one agent — and
	 * "delivered to this agent" meant the first connection handed a message
	 * consumed the only delivery there was. A dead session's bridge still
	 * holding a socket open swallowed the owner's messages whole.
	 */
	it('tells a second session even though the first was already told', async () => {
		const mcp = mcpHarness();
		const { project } = createProject(mcp.h, { name: 'Dashboard' });
		postMessage(mcp.h, { project: project.slug, author: { kind: 'human' }, body: 'both of you' });

		const first = connect(mcp, mcp.token, `?project=${project.slug}&client=session-a`);
		expect(bodiesOf((await first.take(4)).find((frame) => frame.event === 'message'))).toEqual([
			'both of you'
		]);

		// A different session, the same token, the same still-unread message.
		const second = connect(mcp, mcp.token, `?project=${project.slug}&client=session-b`);
		const frames = await second.take(4);
		first.abort.abort();
		second.abort.abort();

		expect(bodiesOf(frames.find((frame) => frame.event === 'message'))).toEqual(['both of you']);
	});

	/**
	 * The half a per-connection memory could not cover.
	 *
	 * Delivery is written down (migration 018), so a dropped connection and a
	 * restarted deployment both come back to an agent that has already been told.
	 * Without this the whole unread pile is announced again every time anything
	 * reconnects — which is what the owner was seeing after every deploy.
	 */
	it('stays quiet on a reconnect about what it already delivered', async () => {
		const mcp = mcpHarness();
		const { project } = createProject(mcp.h, { name: 'Dashboard' });
		postMessage(mcp.h, { project: project.slug, author: { kind: 'human' }, body: 'told you' });

		const first = connect(mcp, mcp.token, `?project=${project.slug}&client=session-a`);
		expect(bodiesOf((await first.take(4)).find((frame) => frame.event === 'message'))).toEqual([
			'told you'
		]);
		first.abort.abort();

		// The same session reconnecting: same client id, same still-unread message.
		const again = connect(mcp, mcp.token, `?project=${project.slug}&client=session-a`);
		const frames = await again.take(3);
		again.abort.abort();

		expect(frames.some((frame) => frame.event === 'message')).toBe(false);
		// And it is still unread: delivery is not reading, so the count stands and
		// `get_messages` will still hand it over.
		expect(counts(workFrames(frames).at(-1)!)).toEqual([1, 0, 0]);
	});

	it('records the delivery for the owner to see, once per agent per message', async () => {
		const mcp = mcpHarness();
		const { project } = createProject(mcp.h, { name: 'Dashboard' });
		const message = postMessage(mcp.h, {
			project: project.slug,
			author: { kind: 'human' },
			body: 'anybody there?'
		});

		const stream = connect(mcp, mcp.token, `?project=${project.slug}`);
		await stream.take(4);
		stream.abort.abort();

		const delivered = deliveriesFor(mcp.h, [message.id]);
		expect(delivered).toHaveLength(1);
		expect(delivered[0]).toMatchObject({ messageId: message.id, agentId: mcp.deps.agent.id });
	});
});

/**
 * Settled requests, down the same pipe as messages (the owner's ask: "form
 * submissions such as clicking buttons or answering questions should go down
 * the same instant delivery channel").
 *
 * Before this a settled request moved `pending_approvals` and nothing else, so
 * an agent that asked a question and carried on working learned the answer only
 * when it next thought to look at a number.
 */
describe('what the owner answered', () => {
	it('pushes the answer itself, not just a count that moved', async () => {
		const mcp = mcpHarness();
		const { project } = createProject(mcp.h, { name: 'Dashboard' });
		const { request } = createRequest(mcp.h, {
			agentId: mcp.deps.agent.id,
			kind: 'buttons',
			question: 'Ship it?',
			options: ['Ship', 'Hold'],
			project: project.slug
		});

		const stream = connect(mcp, mcp.token, `?project=${project.slug}`);
		await stream.take(3);

		answerRequest(mcp.h, { requestId: request.id, value: 'Ship' });
		const frames = await stream.take(5);
		stream.abort.abort();

		const answer = frames.find((frame) => frame.event === 'answer');
		expect(answer?.data).toMatchObject({
			request_id: request.id,
			state: 'answered',
			kind: 'buttons',
			question: 'Ship it?',
			answer: 'Ship',
			project: project.slug
		});
	});

	it('says an ending with no answer is an ending, not a yes', async () => {
		const mcp = mcpHarness();
		const { project } = createProject(mcp.h, { name: 'Dashboard' });
		const { request } = createRequest(mcp.h, {
			agentId: mcp.deps.agent.id,
			kind: 'confirm',
			question: 'Delete the branch?',
			project: project.slug
		});

		const stream = connect(mcp, mcp.token, `?project=${project.slug}`);
		await stream.take(3);

		cancelRequest(mcp.h, request.id);
		const frames = await stream.take(5);
		stream.abort.abort();

		const answer = frames.find((frame) => frame.event === 'answer');
		expect(answer?.data).toMatchObject({ state: 'cancelled', answer: null });
	});

	it('keeps another agent’s answers off this stream', async () => {
		const mcp = mcpHarness();
		const { project } = createProject(mcp.h, { name: 'Dashboard' });
		const other = mcp.mint('other-agent');
		const { request } = createRequest(mcp.h, {
			agentId: other.agentId,
			kind: 'confirm',
			question: 'Not your business',
			project: project.slug
		});

		const stream = connect(mcp, mcp.token, `?project=${project.slug}`);
		await stream.take(3);

		answerRequest(mcp.h, { requestId: request.id, value: true });
		// Nothing is expected from that, so something that *is* this agent's work
		// follows it: waiting for that frame proves the stream was live and that
		// the answer went past it unannounced, rather than merely being slow.
		createTask(mcp.h, {
			project: project.slug,
			title: 'yours',
			agentId: mcp.deps.agent.id
		});
		const frames = await stream.take(4);
		stream.abort.abort();

		expect(frames.some((frame) => frame.event === 'answer')).toBe(false);
		expect(counts(workFrames(frames).at(-1)!)).toEqual([0, 1, 0]);
	});
});

/**
 * Bridges that predate client ids (migration 019).
 *
 * They keep working: nothing durable is keyed to them, so they remember within
 * the connection — which repeats after their own reconnect, and never swallows
 * a delivery another session needed.
 */
describe('a connection that does not name itself', () => {
	it('is told once per connection rather than once per agent', async () => {
		const mcp = mcpHarness();
		const { project } = createProject(mcp.h, { name: 'Dashboard' });
		postMessage(mcp.h, { project: project.slug, author: { kind: 'human' }, body: 'hear me' });

		const first = connect(mcp, mcp.token, `?project=${project.slug}`);
		await first.take(4);
		const second = connect(mcp, mcp.token, `?project=${project.slug}`);
		const frames = await second.take(4);
		first.abort.abort();
		second.abort.abort();

		expect(bodiesOf(frames.find((frame) => frame.event === 'message'))).toEqual(['hear me']);
	});

	it('does not repeat itself while it stays connected', async () => {
		const mcp = mcpHarness();
		const { project } = createProject(mcp.h, { name: 'Dashboard' });
		const stream = connect(mcp, mcp.token, `?project=${project.slug}`);
		await stream.take(3);

		postMessage(mcp.h, { project: project.slug, author: { kind: 'human' }, body: 'first' });
		await stream.take(5);
		postMessage(mcp.h, { project: project.slug, author: { kind: 'human' }, body: 'second' });
		const frames = await stream.take(7);
		stream.abort.abort();

		const messages = frames.filter((frame) => frame.event === 'message');
		expect(messages.flatMap((frame) => bodiesOf(frame))).toEqual(['first', 'second']);
	});

	it('leaves one delivery on the card however many sockets were open', async () => {
		const mcp = mcpHarness();
		const { project } = createProject(mcp.h, { name: 'Dashboard' });
		const message = postMessage(mcp.h, {
			project: project.slug,
			author: { kind: 'human' },
			body: 'once on the card'
		});

		const first = connect(mcp, mcp.token, `?project=${project.slug}`);
		await first.take(4);
		const second = connect(mcp, mcp.token, `?project=${project.slug}&client=session-b`);
		await second.take(4);
		first.abort.abort();
		second.abort.abort();

		expect(deliveriesFor(mcp.h, [message.id])).toHaveLength(1);
	});
});

/**
 * The owner's emoji, down the agent's channel (migration 024).
 *
 * Their words: "I want to be able to react to messages too, and agents will
 * receive this down their channel." A tick on a report is approval and costs
 * them one tap; an agent that never hears it is being managed by silence.
 */
describe('a reaction the owner left', () => {
	it('pushes the emoji, with enough of the message to know which line it was', async () => {
		const mcp = mcpHarness();
		const { project } = createProject(mcp.h, { name: 'Dashboard' });
		const update = postUpdate(mcp.h, {
			project: project.slug,
			agentId: mcp.deps.agent.id,
			body: 'shipped'
		});
		const said = postMessage(mcp.h, {
			author: { kind: 'agent', agentId: mcp.deps.agent.id },
			updateId: update.id,
			body: 'the migration is applied and the numbers add up'
		});

		const stream = connect(mcp, mcp.token, `?project=${project.slug}`);
		await stream.take(3);

		react(mcp.h, { messageId: said.id, actor: { kind: 'human' }, emoji: '✅' });
		const frames = await stream.take(4);
		stream.abort.abort();

		const reaction = frames.find((frame) => frame.event === 'reaction');
		expect(reaction?.data).toMatchObject({
			message_id: said.id,
			emoji: '✅',
			on: true,
			project: project.slug,
			body: 'the migration is applied and the numbers add up'
		});
	});

	it('says when one is taken back, which is news of its own', async () => {
		const mcp = mcpHarness();
		const { project } = createProject(mcp.h, { name: 'Dashboard' });
		const said = postMessage(mcp.h, {
			author: { kind: 'agent', agentId: mcp.deps.agent.id },
			project: project.slug,
			body: 'ready to merge'
		});
		react(mcp.h, { messageId: said.id, actor: { kind: 'human' }, emoji: '👍', on: true });

		const stream = connect(mcp, mcp.token, `?project=${project.slug}`);
		await stream.take(3);

		react(mcp.h, { messageId: said.id, actor: { kind: 'human' }, emoji: '👍', on: false });
		const frames = await stream.take(4);
		stream.abort.abort();

		expect(frames.find((frame) => frame.event === 'reaction')?.data).toMatchObject({
			emoji: '👍',
			on: false
		});
	});

	it('keeps another agent’s reactions, and its messages, off this stream', async () => {
		const mcp = mcpHarness();
		const { project } = createProject(mcp.h, { name: 'Dashboard' });
		const other = mcp.mint('other-agent');
		const theirs = postMessage(mcp.h, {
			author: { kind: 'agent', agentId: other.agentId },
			project: project.slug,
			body: 'not your line'
		});
		const mine = postMessage(mcp.h, {
			author: { kind: 'agent', agentId: mcp.deps.agent.id },
			project: project.slug,
			body: 'yours'
		});

		const stream = connect(mcp, mcp.token, `?project=${project.slug}`);
		await stream.take(3);

		// On somebody else's message: none of this agent's business.
		react(mcp.h, { messageId: theirs.id, actor: { kind: 'human' }, emoji: '👀' });
		// By an agent rather than the owner: not feedback, and not news.
		react(mcp.h, {
			messageId: mine.id,
			actor: { kind: 'agent', agentId: other.agentId },
			emoji: '👀'
		});
		// And one that *is*, so the wait ends on a frame that proves the stream
		// was live rather than merely quiet.
		react(mcp.h, { messageId: mine.id, actor: { kind: 'human' }, emoji: '🎉' });

		// Five, not four: the other agent's message is unread for this one too, so
		// the connection opens with a message frame of its own.
		const frames = await stream.take(5);
		stream.abort.abort();

		const reactions = frames.filter((frame) => frame.event === 'reaction');
		expect(reactions).toHaveLength(1);
		expect(reactions[0]?.data).toMatchObject({ message_id: mine.id, emoji: '🎉' });
	});
});
