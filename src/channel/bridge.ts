/**
 * The dashboard as a Claude Code **channel** (design §5).
 *
 * ## What this is, and why it is a separate process
 *
 * A Claude Code channel is an MCP server that Claude Code **spawns itself, over
 * stdio**, and that pushes `notifications/claude/channel` events into the live
 * session. The dashboard's own MCP server is remote — Streamable HTTP at
 * `/mcp`, behind a bearer token — and a remote server cannot be a channel: it
 * has no stdio to be spawned on. So the bridge is the missing half. It runs
 * beside the agent, holds one connection to the dashboard, and turns what
 * arrives into a channel notification.
 *
 * ```
 *   dashboard  ──SSE /api/agent/stream──▶  bridge (this file)  ──stdio──▶  Claude Code
 * ```
 *
 * ## It pushes the message, and the counts around it
 *
 * This started as counts only, on the theory that a notification should say
 * *that* there is work and leave the reading to the tools. In use that was too
 * thin: "1 unread message" costs a tool call before the agent knows whether the
 * message even concerns what it is doing, and an agent woken by a project it
 * has never touched learns to ignore the channel. So a message arrives with its
 * text, its ids and its project on the tag, and the dashboard only sends the
 * ones belonging to projects that agent actually works in.
 *
 * The tools still do the rest: `get_messages` is the only thing that marks
 * anything read, and tasks and approvals are still counts pointing at
 * `list_tasks` and `await_request`. This process remains a read-only client of
 * the dashboard with no write path at all.
 *
 * For the same reason it is a **one-way** channel: no `tools` capability, no
 * reply tool. Claude already has fifteen tools pointed at this dashboard; a
 * sixteenth that duplicated `post_update` over a second transport would be a
 * second way to do one thing, and the two would drift.
 *
 * It also does not declare `claude/channel/permission`. Permission relay would
 * let whoever can reach the dashboard approve tool calls in the agent's
 * session, and this bridge authenticates the *dashboard*, not the person typing
 * into it — the docs are explicit that only a channel which authenticates the
 * sender should offer relay.
 *
 * ## Silence is not the same as nothing
 *
 * A dropped connection looks exactly like a quiet dashboard, so the bridge
 * reconnects with backoff, and every reconnect opens with the current counts
 * rather than a replay (the server sends them on connect). That is what makes
 * this safe to lose: the worst case is a late notification, never a wrong one.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

/** What the dashboard's agent stream sends. */
export type WorkFrame = {
	type: 'work';
	unread_messages: number;
	open_tasks: number;
	pending_approvals: number;
	at: string;
};

/** The three counts, as the bridge compares them between frames. */
export type Work = Pick<WorkFrame, 'unread_messages' | 'open_tasks' | 'pending_approvals'>;

/** One unread message, as the dashboard describes it on the stream. */
export type ChannelMessage = {
	message_id: string;
	project_id: string | null;
	project: string | null;
	project_name: string | null;
	update_id: string | null;
	task_id: string | null;
	author: string;
	body: string;
	created_at: string;
};

/** What an `event: message` frame carries. */
export type MessageFrame = { type: 'message'; messages: ChannelMessage[] };

export const CHANNEL_NAME = 'agent-dashboard';

/**
 * What Claude is told the moment the channel connects.
 *
 * Deliberately specific about what to *do*: an event that said only "you have
 * messages" would leave Claude to guess which tool answers it, and guessing
 * wrong costs a turn. It also says what not to do — a count of zero is the
 * dashboard going quiet, not an instruction to go and check.
 */
export const INSTRUCTIONS = [
	// The `source` attribute is the name of the *MCP config entry*, not this
	// server's own name, so it is not interpolated from CHANNEL_NAME: a
	// deployment that registers the entry as `agent-dashboard-channel` gets that
	// word on the tag, and an instruction naming the wrong attribute value would
	// have every agent looking for a tag that never arrives.
	'Events from this dashboard arrive as a <channel> tag whose source attribute is the name',
	'this server was registered under, e.g. <channel source="agent-dashboard-channel" ...>.',
	'They mean work is waiting for you on the dashboard, and they carry counts rather than',
	'content, so read the work with the tools you already have on the agent-dashboard MCP',
	'server:',
	'',
	'- A message event carries the text itself, with message_id, project, update_id and',
	'  task_id on the tag. Acknowledge it first — acknowledge({state: "thinking", message_id})',
	'  puts a live "is thinking…" on it so your owner can see you have it — then reply where it',
	'  came from with post_message, passing that update_id or task_id, and call get_messages to',
	'  mark it read. acknowledge({state: "done", message_id}) when you have dealt with it.',
	'  A message with NO update_id and NO task_id is a post your owner wrote straight into the',
	'  feed: it is the thing itself rather than a comment on something, so acknowledge it the same',
	'  way, then decide what it needs — create_task for work, post_message({message_id}) to answer',
	'  or to ask them a question — and do not wait to be told which.',
	'- open_tasks above zero: call list_tasks, then claim_task for anything you are picking up.',
	"  A task marked broadcast: true was offered to this project's agents rather than assigned",
	'  to you, so somebody else may claim it first — a conflict means move on, not retry.',
	'- pending_approvals above zero: one of your own request_input calls is still waiting on',
	'  the owner; call await_request with its request_id.',
	'',
	'You are only told about projects this session is subscribed to, so anything that arrives',
	'is your business.',
	'',
	'These are one-way notifications: there is no reply tool on this channel, and nothing is',
	'expected back through it. A count that drops to zero means the work is done or was',
	'withdrawn — it is not a prompt to act.'
].join('\n');

/** Seconds to wait before reconnecting, backing off and then holding steady. */
export const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

export type BridgeOptions = {
	/** Where the dashboard lives, e.g. `https://agents.example.com`. */
	baseUrl: string;
	/** The agent's bearer token — the same one its MCP config uses. */
	token: string;
	/**
	 * Which projects this session is for. Required, and never inferred.
	 *
	 * The answer to an agent hearing about work that is none of its business: a
	 * megamerge session subscribes to megamerge and is deaf to everything else,
	 * however many projects the token has touched over its life.
	 *
	 * `['*']` is the way to say "every project", and it has to be typed. The
	 * bridge used to treat an unset variable as that, by deriving relevance from
	 * what the agent had done — which meant the commonest configuration was the
	 * one nobody had chosen, and an agent's scope was decided by its own history
	 * rather than by whoever set the session up. {@link main} now refuses to start
	 * without it.
	 */
	projects: readonly string[];
	/** Test seam. */
	fetch?: typeof globalThis.fetch;
	/** Test seam: how a notification leaves. Defaults to the MCP server's. */
	notify?: (content: string, meta: Record<string, string>) => Promise<void>;
	/** Test seam: waiting between reconnects. */
	sleep?: (ms: number) => Promise<void>;
	/** Test seam: stop looping. Defaults to "never". */
	signal?: AbortSignal;
	/** Where diagnostics go. Never stdout: that is the MCP transport. */
	log?: (message: string) => void;
};

/**
 * What this server declares itself able to do.
 *
 * A named constant rather than an inline literal because it is the entire
 * contract with Claude Code, and the three things it does *not* say matter as
 * much as the one it does — the MCP SDK keeps its own copy private, so this is
 * the only place a test can read them.
 */
export const CAPABILITIES = {
	// This key is what makes it a channel: Claude Code registers a notification
	// listener when it sees it, and drops every notification in silence when it
	// does not. No `tools` key beside it — one-way. No
	// `claude/channel/permission` either.
	experimental: { 'claude/channel': {} }
} as const;

/** Build the MCP server half: the capability declaration and nothing else. */
export function createChannelServer(): Server {
	return new Server(
		{ name: CHANNEL_NAME, version: '0.1.0' },
		{ capabilities: CAPABILITIES, instructions: INSTRUCTIONS }
	);
}

/**
 * What one change is worth saying out loud.
 *
 * Only the counts that went **up** are mentioned. A frame arrives whenever any
 * of the three moves, including when the agent itself clears its own inbox, and
 * "you have 0 messages" is noise that costs a turn to read.
 *
 * @returns the sentence, or `null` when nothing rose.
 */
export function describeRise(previous: Work | null, next: Work): string | null {
	const parts: string[] = [];
	const rose = (before: number, after: number) => previous === null || after > before;

	if (rose(previous?.unread_messages ?? 0, next.unread_messages) && next.unread_messages > 0) {
		parts.push(
			next.unread_messages === 1
				? '1 unread message from your owner'
				: `${next.unread_messages} unread messages from your owner`
		);
	}
	if (rose(previous?.open_tasks ?? 0, next.open_tasks) && next.open_tasks > 0) {
		parts.push(next.open_tasks === 1 ? '1 open task' : `${next.open_tasks} open tasks`);
	}
	if (
		rose(previous?.pending_approvals ?? 0, next.pending_approvals) &&
		next.pending_approvals > 0
	) {
		parts.push(
			next.pending_approvals === 1
				? '1 request still waiting on your owner'
				: `${next.pending_approvals} requests still waiting on your owner`
		);
	}

	if (parts.length === 0) return null;
	return `Waiting for you on the dashboard: ${parts.join(', ')}.`;
}

/** Split an SSE body into frames as the bytes arrive. */
export async function* readFrames(
	body: ReadableStream<Uint8Array>
): AsyncGenerator<Record<string, string>> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffered = '';

	while (true) {
		const chunk = await reader.read();
		if (chunk.done) return;
		buffered += decoder.decode(chunk.value, { stream: true });

		let split = buffered.indexOf('\n\n');
		while (split !== -1) {
			const block = buffered.slice(0, split);
			buffered = buffered.slice(split + 2);
			const frame: Record<string, string> = {};
			for (const line of block.split('\n')) {
				const colon = line.indexOf(':');
				// A comment (`: heartbeat`) has an empty field name and is skipped.
				if (colon <= 0) continue;
				frame[line.slice(0, colon)] = line.slice(colon + 1).trimStart();
			}
			if (Object.keys(frame).length > 0) yield frame;
			split = buffered.indexOf('\n\n');
		}
	}
}

/**
 * Hold the dashboard's agent stream open and push what arrives into the session.
 *
 * Runs until `signal` aborts. Never throws for a connection problem: the
 * dashboard being unreachable is a thing that happens, and a bridge that exited
 * would take the channel down for the rest of the session with no way back.
 */
export async function runBridge(options: BridgeOptions): Promise<void> {
	const {
		baseUrl,
		token,
		fetch: fetcher = globalThis.fetch,
		notify,
		sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
		signal,
		log = () => {}
	} = options;

	if (!notify) throw new Error('runBridge needs a notify function');

	const endpoint = new URL('/api/agent/stream', baseUrl);
	for (const project of options.projects) {
		if (project.trim() !== '') endpoint.searchParams.append('project', project.trim());
	}
	const url = endpoint.toString();

	/**
	 * A rise waiting for the message frame that explains it.
	 *
	 * The dashboard sends the counts and then, when unread messages went up, the
	 * messages themselves. Holding the first for the second means one
	 * notification carrying the text rather than two, the first of which says
	 * only that a second is coming.
	 */
	let pendingCounts: { work: Work; sentence: string } | null = null;

	const meta = (work: Work): Record<string, string> => ({
		unread_messages: String(work.unread_messages),
		open_tasks: String(work.open_tasks),
		pending_approvals: String(work.pending_approvals)
	});

	/** Send a held rise with no message behind it: a task, or an approval. */
	const flush = async (send: NonNullable<BridgeOptions['notify']>) => {
		if (pendingCounts === null) return;
		const { work, sentence } = pendingCounts;
		pendingCounts = null;
		await send(sentence, meta(work));
	};

	/**
	 * Message ids already delivered, so nothing is announced twice.
	 *
	 * The stream sends the *unread set*, not a delta — it is recomputed from the
	 * read cursor on every frame, and the cursor only moves when the agent calls
	 * `get_messages`. So an agent that has been told about a message and has not
	 * yet read it is told again on the next rise, and again on the one after
	 * that: five messages arriving one at a time meant fifteen notifications for
	 * five things.
	 *
	 * The bridge is the right place to remember, because "have I already said
	 * this" is a fact about this connection rather than about the dashboard —
	 * the messages really are still unread, and the dashboard is right to keep
	 * saying so.
	 */
	const announced = new Set<string>();

	/** Enough that nothing repeats in practice; bounded so a long run cannot leak. */
	const ANNOUNCED_MAX = 500;

	const remember = (id: string) => {
		announced.add(id);
		if (announced.size > ANNOUNCED_MAX) {
			// Oldest first: `Set` keeps insertion order, so this drops what was said
			// longest ago, which is what an agent is least likely to be told again.
			const oldest = announced.values().next().value;
			if (oldest !== undefined) announced.delete(oldest);
		}
	};

	/** Send the messages themselves, one notification each. */
	const announce = async (send: NonNullable<BridgeOptions['notify']>, all: ChannelMessage[]) => {
		const held = pendingCounts;
		pendingCounts = null;

		const messages = all.filter((message) => !announced.has(message.message_id));
		if (messages.length === 0) {
			// Either nothing came with the counts, or all of it has already been
			// said. The first is worth a sentence; the second is not — repeating
			// "1 unread message" about something the agent was already handed is how
			// a channel teaches its reader to ignore it.
			if (held && all.length === 0) await send(held.sentence, meta(held.work));
			return;
		}

		for (const message of messages) {
			// Every id the agent needs to answer where it was asked, as tag
			// attributes — `post_message` takes update_id or task_id verbatim.
			const attributes: Record<string, string> = { message_id: message.message_id };
			if (message.project) attributes.project = message.project;
			if (message.project_id) attributes.project_id = message.project_id;
			if (message.update_id) attributes.update_id = message.update_id;
			if (message.task_id) attributes.task_id = message.task_id;
			if (held) Object.assign(attributes, meta(held.work));

			const where = message.project_name ?? message.project ?? 'the dashboard';
			const who = message.author === 'human' ? 'Your owner' : message.author;
			remember(message.message_id);
			await send(`${who} on ${where}: ${message.body}`, attributes);
		}
	};
	// Held across reconnects on purpose: the server opens every connection with
	// the current counts, and re-announcing work the agent was already told about
	// would interrupt it for nothing.
	let previous: Work | null = null;
	let attempt = 0;

	while (!signal?.aborted) {
		try {
			const response = await fetcher(url, {
				headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
				signal
			});

			if (!response.ok || !response.body) {
				// 401 is terminal in every practical sense — a bad token will still be
				// bad in thirty seconds — but it is not worth exiting over: the owner
				// may be re-minting one, and a bridge that gave up would need the
				// session restarted to come back.
				log(`stream refused: ${response.status}`);
				throw new Error(`stream refused: ${response.status}`);
			}

			log('connected');
			attempt = 0;

			for await (const frame of readFrames(response.body)) {
				if (frame.event === 'message' && frame.data) {
					try {
						const parsed = JSON.parse(frame.data) as MessageFrame;
						await announce(notify, parsed.messages ?? []);
					} catch {
						// A malformed frame must not drop a working connection.
					}
					continue;
				}
				if (frame.event !== 'work' || !frame.data) continue;

				let work: WorkFrame;
				try {
					work = JSON.parse(frame.data) as WorkFrame;
				} catch {
					// One malformed frame must not drop a working connection.
					continue;
				}

				// A rise still held from an earlier frame goes out now. Holding one
				// for a message frame is right; holding it *for ever* is how the
				// channel went quiet — the server had nothing scoped to send, so the
				// frame never came, and the notification sat here while its owner
				// wondered why nobody was answering.
				await flush(notify);

				const sentence = describeRise(previous, work);
				previous = work;
				if (sentence === null) continue;
				pendingCounts = { work, sentence };
				// Nothing is sent yet: the message frame that follows a rise carries
				// what the counts are about, and one notification with the text beats
				// two where the first says only that a second is coming. A rise with no
				// message frame behind it — a task, an approval — is flushed below.
				if (work.unread_messages === 0) {
					await flush(notify);
					continue;
				}
			}

			// A rise held for a message frame that never came — the connection dropped
			// between the two — is still news. Better a notification without the text
			// than silence about work that is waiting.
			await flush(notify);
			log('stream ended');
		} catch (error) {
			if (signal?.aborted) return;
			log(`stream failed: ${error instanceof Error ? error.message : String(error)}`);
		}

		if (signal?.aborted) return;
		const wait = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!;
		attempt += 1;
		await sleep(wait);
	}
}

/** Wire the MCP server to the bridge and run until the process is killed. */
export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
	const baseUrl = env.AGENT_DASHBOARD_URL?.trim();
	const token = env.AGENT_DASHBOARD_TOKEN?.trim();
	// Comma separated, so one env var covers a session that works across two
	// projects without inventing a list format nobody would remember.
	const projects = (env.AGENT_DASHBOARD_PROJECTS ?? '')
		.split(',')
		.map((project) => project.trim())
		.filter((project) => project !== '');

	if (!baseUrl || !token) {
		// stderr, never stdout: stdout is the MCP transport, and a stray line on it
		// is a protocol error rather than a message anybody reads.
		process.stderr.write(
			'agent-dashboard channel: set AGENT_DASHBOARD_URL and AGENT_DASHBOARD_TOKEN\n'
		);
		process.exitCode = 1;
		return;
	}

	// Refused rather than defaulted. An unset subscription used to mean "work it
	// out from what this agent has done", which made the commonest configuration
	// the one nobody had chosen: a session was woken by whatever its token had
	// touched in its life, and the way to find that out was to be interrupted by
	// it. Saying so costs one line of config and is the difference between a
	// scope somebody decided and a scope that accumulated.
	if (projects.length === 0) {
		process.stderr.write(
			'agent-dashboard channel: set AGENT_DASHBOARD_PROJECTS to the project slugs this ' +
				'session is for, comma separated — or to * for every project. It is required: ' +
				'there is no default scope.\n'
		);
		process.exitCode = 1;
		return;
	}

	const mcp = createChannelServer();
	await mcp.connect(new StdioServerTransport());

	await runBridge({
		baseUrl,
		token,
		projects,
		log: (message) => process.stderr.write(`agent-dashboard channel: ${message}\n`),
		notify: (content, meta) =>
			mcp.notification({ method: 'notifications/claude/channel', params: { content, meta } })
	});
}
