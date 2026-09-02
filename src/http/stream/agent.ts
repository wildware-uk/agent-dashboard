/**
 * `GET /api/agent/stream` — the agent's own live pipe (design §4, §5).
 *
 * ## Why this exists alongside `/api/stream`
 *
 * The owner's stream carries every event in the deployment and is guarded by
 * the session cookie. An agent must have neither: it authenticates with a
 * bearer token (§5), and it has no business hearing about another project's
 * updates, another agent's requests, or anything the owner is doing. So this is
 * a second, deliberately much smaller stream — same transport, different
 * audience, different authority.
 *
 * ## What it carries, and what it deliberately does not
 *
 * One event type: `work`, the same three counts a `heartbeat` answers with
 * (`countWork` in `src/domain/sessions.ts`). Not the messages, not the tasks,
 * not the answers — the *counts*, and only when they change.
 *
 * That is the whole design decision here. Pushing the content would mean a
 * second wire format for every kind of work, drifting against the tools that
 * already return them, and it would put an agent's inbox on a socket that can
 * drop. Pushing a count says "there is something for you" and leaves the
 * reading to `get_messages` and `list_tasks`, which are the same calls the
 * agent already makes after a heartbeat says the same thing. The stream
 * replaces the *polling*, not the tools.
 *
 * A connection is therefore worth exactly one thing: latency. A reply the owner
 * types reaches the agent in milliseconds rather than on its next beat.
 *
 * ## Counts are recomputed, never accumulated
 *
 * Every watched event recomputes all three counts from the database and sends
 * them only if they differ from the last set written. That makes double
 * delivery, replay and a missed frame all harmless — the next event resyncs the
 * agent completely — and it is why there is no cursor and no `Last-Event-ID`
 * handling on this route. The first frame after connecting is the current
 * counts, so an agent that reconnects after an outage is immediately correct
 * without asking for a replay it would have to merge.
 */
import {
	countOpenTasks,
	countUnreadMessagesInScope,
	countWork,
	findProject,
	invalid,
	isDomainError,
	notFound,
	type Project,
	unreadMessagesInScope,
	context as sharedContext,
	type DomainContext,
	type WorkCounts
} from '$domain';
import { bus as sharedBus, type AppEvent, type EventBus, type Unsubscribe } from '$events';
import {
	authenticateMcpRequest,
	createTokenRateLimiter,
	mcpConfig,
	type McpConfig,
	type TokenRateLimiter
} from '$mcp';
import { SSE_HEADERS, commentFrame, retryFrame } from './frames';

/** The counts frame: what is waiting, as three numbers. */
export const WORK_EVENT = 'work';

/**
 * The message frame: one unread message, in full.
 *
 * Added after the counts alone proved too thin in use. A count tells an agent
 * to go and look, which costs a tool call before it knows whether the message
 * even concerns what it is doing; the text, the ids and the project name let it
 * decide first and read second. `get_messages` is still the only thing that
 * marks anything read, so this changes what an agent *knows*, never what the
 * dashboard thinks it has seen.
 */
export const MESSAGE_EVENT = 'message';

/** How many unread messages one frame will describe. */
export const MESSAGE_LIMIT = 5;

/**
 * How many message ids one connection remembers having sent.
 *
 * Bounded so a connection held open for days cannot grow without limit, and
 * generous enough that nothing repeats in practice: the oldest id dropped is the
 * one an agent is least likely to be told about again, because the read cursor
 * has long since passed it.
 */
export const ANNOUNCED_MAX = 500;

/** The query parameter an agent subscribes with: `?project=a,b`. */
export const PROJECT_PARAM = 'project';

/** The wildcard a session sends to say "every project in this deployment". */
export const ALL_PROJECTS = '*';

/**
 * Which projects this connection wants.
 *
 * Three answers, and the difference between them is the whole of what a session
 * can ask for:
 *
 * - **a list of ids** — only these. The answer to an agent hearing about work
 *   that is none of its business: a megamerge session subscribes to megamerge
 *   and is deaf to everything else, however many projects the token has touched.
 * - **`null`** — every project in the deployment, asked for explicitly with
 *   `?project=*`. Not the same as the case below: this is a session saying it
 *   wants the lot, and it gets the lot including projects the agent has never
 *   been near.
 * - **`undefined`** — nothing was asked for, so relevance is derived from what
 *   the agent has actually done. Kept for any client that is not the bridge; the
 *   bridge itself now refuses to start without an explicit subscription, because
 *   a default that silently decides an agent's scope is a default nobody reads.
 *
 * An unknown slug is refused rather than ignored. Silently dropping a typo would
 * scope the stream to nothing and look exactly like a quiet dashboard, which is
 * the worst failure this surface can have — and for the same reason `*` mixed
 * with slugs is refused rather than resolved: the caller cannot have meant both,
 * and guessing which half to honour would hide the mistake.
 *
 * @throws {DomainError} `not_found` for a project that does not exist,
 *   `invalid_argument` for `*` alongside anything else.
 */
function subscription(ctx: DomainContext, url: URL): string[] | null | undefined {
	const raw = url.searchParams.getAll(PROJECT_PARAM).flatMap((value) => value.split(','));
	const wanted = raw.map((value) => value.trim()).filter((value) => value !== '');
	if (wanted.length === 0) return undefined;

	if (wanted.includes(ALL_PROJECTS)) {
		if (wanted.length > 1) {
			throw invalid(`${ALL_PROJECTS} means every project, so it cannot be listed beside others`);
		}
		return null;
	}

	return wanted.map((reference) => {
		const project: Project | undefined = findProject(ctx, reference);
		if (!project) throw notFound(`no such project: ${reference}`);
		return project.id;
	});
}

/**
 * The events that can change what is waiting for an agent.
 *
 * Narrow on purpose: an update posted in a project the agent is not working in
 * must not wake every connected agent to recount. Anything absent here simply
 * cannot move one of the three counts.
 */
const WATCHED: readonly AppEvent['type'][] = [
	'message.created',
	// A message was deleted (migration 017), which lowers an unread count exactly
	// as reading it does. Without this the agent is left holding a figure for a
	// message nobody can show it, and the next real one looks like a fall.
	'message.deleted',
	// The agent's own read, which lowers its unread count. Watched for the same
	// reason the others are: it moves a number this stream exists to report, and
	// a fall nobody is told about is a stale baseline downstream.
	'messages.read',
	'task.created',
	'task.updated',
	'request.created',
	'request.answered'
];

/** Between comment frames, so a dead connection is noticed rather than wedged. */
export const AGENT_HEARTBEAT_MS = 15_000;

/** The `retry:` hint: how long a dropped agent waits before reconnecting. */
export const AGENT_RETRY_MS = 2_000;

/** The slice of SvelteKit's `RequestEvent` this route needs. */
export type AgentStreamRequestEvent = { request: Request };

export type AgentStreamHandlerOptions = {
	bus?: EventBus;
	/** Defaults to the process-wide handle. Tests pass their own. */
	context?: () => DomainContext;
	/** Auth secrets, injectable so tests need no environment. */
	config?: () => McpConfig | null;
	/** Shared with `/mcp` in production so one token has one budget. */
	rateLimiter?: TokenRateLimiter;
	/** Milliseconds between comment frames. `0` disables the heartbeat. */
	heartbeatMs?: number;
	retryMs?: number;
};

export type AgentStreamHandler = (event: AgentStreamRequestEvent) => Response;

/** One frame: the counts, and when they were taken. */
function workFrame(work: WorkCounts, at: number): string {
	const body = JSON.stringify({
		type: WORK_EVENT,
		unread_messages: work.unreadMessages,
		open_tasks: work.openTasks,
		pending_approvals: work.pendingApprovals,
		at: new Date(at).toISOString()
	});
	return `event: ${WORK_EVENT}\ndata: ${body}\n\n`;
}

/**
 * The counts as *this stream* reports them.
 *
 * `unreadMessages` is replaced with a project-scoped count, which is the one
 * place this surface deliberately disagrees with `heartbeat`. A heartbeat
 * answers "is there anything for me anywhere" and must span every project or it
 * would be a no that means yes. A live stream answers "should I interrupt this
 * agent now", and waking one for a project it has never touched is the
 * interruption that made agents start ignoring the channel.
 *
 * `openTasks` is re-counted for the narrower half of the same reason. A task
 * assigned to this agent by name is its work wherever it was filed, so the count
 * of those does not move; what the subscription scopes is *broadcast* work —
 * offered to a project's agents rather than to anybody in particular — and a
 * session that said which projects it is for must not be woken to race for a job
 * in one of the others.
 */
function scopedWork(
	ctx: DomainContext,
	agentId: string,
	subscribed: readonly string[] | null | undefined
): WorkCounts {
	return {
		...countWork(ctx, agentId),
		unreadMessages: countUnreadMessagesInScope(ctx, agentId, subscribed),
		openTasks: countOpenTasks(ctx, agentId, subscribed)
	};
}

/**
 * One unread message, with enough around it to be acted on without a lookup.
 *
 * **Only what this connection has not already sent.** `unreadMessagesInScope`
 * answers with the unread *set*, recomputed from the read cursor — and that
 * cursor only moves when the agent calls `get_messages`. So a second message
 * would carry the first again, a third would carry both, and an owner typing
 * five lines interrupted an agent fifteen times about five things. That is the
 * complaint that would not go away, and it is fixed here rather than only in the
 * bridge because a session launched days ago is still running the bridge it
 * started with: a server that never repeats itself reaches every client, old
 * code included.
 *
 * `sent` is per connection, so a reconnecting agent still opens with whatever is
 * waiting — silence into a full inbox would be the worse failure.
 */
function messageFrame(
	ctx: DomainContext,
	agentId: string,
	subscribed: readonly string[] | null | undefined,
	sent: Set<string>
): string {
	const unread = unreadMessagesInScope(ctx, agentId, MESSAGE_LIMIT, subscribed);
	const messages = unread.filter((message) => !sent.has(message.id));
	if (messages.length === 0) return '';

	for (const message of messages) remember(sent, message.id);

	const body = JSON.stringify({
		type: MESSAGE_EVENT,
		messages: messages.map((message) => {
			const project = message.projectId ? findProject(ctx, message.projectId) : null;
			return {
				message_id: message.id,
				project_id: message.projectId,
				project: project?.slug ?? null,
				project_name: project?.name ?? null,
				update_id: message.updateId,
				task_id: message.taskId,
				author: message.author,
				body: message.body,
				created_at: new Date(message.createdAt).toISOString()
			};
		})
	});
	return `event: ${MESSAGE_EVENT}\ndata: ${body}\n\n`;
}

/** Note an id as sent, dropping the oldest once the set is full. */
function remember(sent: Set<string>, id: string): void {
	sent.add(id);
	if (sent.size <= ANNOUNCED_MAX) return;
	// `Set` keeps insertion order, so this drops what was said longest ago.
	const oldest = sent.values().next().value;
	if (oldest !== undefined) sent.delete(oldest);
}

function same(left: WorkCounts, right: WorkCounts): boolean {
	return (
		left.unreadMessages === right.unreadMessages &&
		left.openTasks === right.openTasks &&
		left.pendingApprovals === right.pendingApprovals
	);
}

/** A refusal an agent can act on, in the same shape `/mcp` refuses with. */
function refusal(status: number, error: string, message: string): Response {
	return new Response(JSON.stringify({ error, message }), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

/**
 * Build the `GET` handler for the agent stream.
 *
 * Synchronous for the same reason the owner's is: the bus subscription and the
 * first count have to happen in one tick, or an event published between them is
 * seen by neither.
 */
export function createAgentStreamHandler(
	options: AgentStreamHandlerOptions = {}
): AgentStreamHandler {
	const {
		bus = sharedBus,
		context: getContext = sharedContext,
		config = mcpConfig,
		rateLimiter = createTokenRateLimiter(),
		heartbeatMs = AGENT_HEARTBEAT_MS,
		retryMs = AGENT_RETRY_MS
	} = options;

	return (event) => {
		const settings = config();
		if (settings === null) {
			return refusal(
				503,
				'misconfigured',
				'this deployment has no TOKEN_SECRET, so no token can be verified'
			);
		}

		const ctx = getContext();
		const auth = authenticateMcpRequest({
			request: event.request,
			ctx,
			secret: settings.tokenSecret,
			rateLimiter
		});
		if (!auth.ok) return refusal(auth.status, auth.error, auth.message);

		const agentId = auth.agent.id;

		let subscribed: string[] | null | undefined;
		try {
			subscribed = subscription(ctx, new URL(event.request.url));
		} catch (error) {
			// A typo in a config is a refusal the operator can see, never a stream
			// that silently carries nothing. The two are told apart because they are
			// different mistakes: a slug that names nothing is a 404, and a
			// subscription that contradicts itself is a 400.
			const message = error instanceof Error ? error.message : 'no such project';
			return isDomainError(error) && error.code === 'invalid_argument'
				? refusal(400, error.code, message)
				: refusal(404, 'not_found', message);
		}

		const encoder = new TextEncoder();
		// Assigned in `start`, which a ReadableStream runs synchronously during
		// construction, so `cancel` can never see the placeholder.
		let teardown = () => {};

		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				let open = true;
				let unsubscribe: Unsubscribe = () => {};
				let heartbeat: ReturnType<typeof setInterval> | undefined;

				const write = (frame: string) => {
					if (!open) return;
					try {
						controller.enqueue(encoder.encode(frame));
					} catch {
						// The agent went away between our last check and this write.
						teardown();
					}
				};

				teardown = () => {
					if (!open) return;
					open = false;
					unsubscribe();
					if (heartbeat !== undefined) clearInterval(heartbeat);
					event.request.signal?.removeEventListener('abort', teardown);
					try {
						controller.close();
					} catch {
						// Already closed or cancelled. Idempotent by design: abort and
						// cancel both land here, and either may arrive first.
					}
				};

				// The comment is what forces a proxy to flush the response headers, so
				// the bridge sees the connection open immediately rather than whenever
				// the agent's first piece of work happens to arrive.
				write(`${retryFrame(retryMs)}${commentFrame('connected')}`);

				/** What this connection has already announced, so it says nothing twice. */
				const sent = new Set<string>();

				// The current counts before any event, so a reconnecting agent is
				// correct without a replay to merge.
				let last = scopedWork(ctx, agentId, subscribed);
				write(workFrame(last, ctx.now()));
				if (last.unreadMessages > 0) write(messageFrame(ctx, agentId, subscribed, sent));

				unsubscribe = bus.subscribe((published: AppEvent) => {
					if (!WATCHED.includes(published.type)) return;
					// Recomputed rather than derived from the payload: the event says
					// something happened somewhere, and whether it is *this* agent's
					// work is a question only the database can answer.
					let next: WorkCounts;
					try {
						next = scopedWork(ctx, agentId, subscribed);
					} catch {
						// A read that fails must not tear down a live connection: the next
						// event recomputes, and the counts are absolute rather than
						// accumulated, so nothing is lost by skipping one.
						return;
					}
					if (same(last, next)) return;
					const rose = next.unreadMessages > last.unreadMessages;
					last = next;
					write(workFrame(next, ctx.now()));
					// The messages themselves, but only when there are more than there
					// were: a count that fell is the agent reading its own inbox, and
					// re-sending what it just read would be the same interruption twice.
					if (rose) write(messageFrame(ctx, agentId, subscribed, sent));
				});

				if (heartbeatMs > 0) {
					heartbeat = setInterval(
						() => write(commentFrame(`heartbeat ${new Date().toISOString()}`)),
						heartbeatMs
					);
					// Don't hold the process open for an idle agent.
					heartbeat.unref?.();
				}

				const signal = event.request.signal;
				signal?.addEventListener('abort', teardown, { once: true });
				// An already-aborted request never fires the listener above.
				if (signal?.aborted) teardown();
			},
			cancel() {
				teardown();
			}
		});

		return new Response(body, { status: 200, headers: { ...SSE_HEADERS } });
	};
}
