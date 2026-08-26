/**
 * The owner's half of messages (design §7): the reply box, and the thread a card
 * renders inline.
 *
 * Two endpoints, and the same three rules the rest of `../owner/` keeps — the
 * domain does the work, the write publishes so every open tab follows, and the
 * session is checked here as well as in the hook. The wrapper that enforces the
 * last of those is imported from `./actions.ts` rather than written again: it is
 * the only lock on these routes.
 *
 * `GET` is here rather than beside the snapshot endpoints because it is the same
 * *surface* as the reply: one file to read to see everything the browser may do
 * with messages. It answers the whole scope in one request — every message in a
 * project, its cards' threads included — because the alternative is one request
 * per card on a fifty-card timeline.
 *
 * The owner is `human`, never an agent id: the author is decided here from the
 * session cookie, so a body that hopefully says `author` is dropped like any
 * other field only the server gets to decide.
 */
import { bus as sharedBus, type EventBus } from '$events';
import { invalid, listThread, postMessage, type ThreadQuery } from '$domain';
import {
	ownerAction,
	readOwnerJson,
	type OwnerActionEvent,
	type OwnerHandler,
	type OwnerHandlerOptions
} from './actions';

export type { OwnerActionEvent, OwnerHandler };

export type MessageHandlerOptions = OwnerHandlerOptions & {
	/**
	 * The bus whose cursor stamps a thread read. Tests hand over their own; in
	 * production it is the process-wide one.
	 */
	bus?: EventBus;
};

/** What a `POST /api/messages` body may say. */
type Body = Record<string, unknown>;

/**
 * `POST /api/messages` — the owner replies (design §7).
 *
 * 201 always: a message is a new row every time. There is no idempotency to
 * claim here, and pretending otherwise would make a double-click quietly
 * disappear rather than post twice.
 */
export function postMessageHandler(options: MessageHandlerOptions = {}): OwnerHandler {
	return ownerAction(options, async (event, ctx) => {
		const input = readReply(await readOwnerJson(event.request));
		const message = postMessage(ctx, { author: { kind: 'human' }, ...input });
		return { status: 201, body: { message } };
	});
}

/**
 * `GET /api/messages` — a thread, or every thread in a project.
 *
 * Stamped with the stream cursor **read before the messages**, for the reason
 * `../stream/snapshot.ts` spells out: `seq` has to mean "this state accounts for
 * every event up to here", so that a browser can discard the frames it already
 * has. Reading it afterwards would let a message published mid-read be dismissed
 * as already-included, and the thread would sit stale until the next reconnect.
 */
export function listMessagesHandler(options: MessageHandlerOptions = {}): OwnerHandler {
	const bus = options.bus ?? sharedBus;

	return ownerAction(options, (event, ctx) => {
		const seq = bus.lastSeq;
		const query = readThreadQuery(new URL(event.request.url));

		return Promise.resolve({
			status: 200,
			body: { seq, at: new Date().toISOString(), messages: listThread(ctx, query) }
		});
	});
}

/** What the reply box sends: some text, and what it is a reply to. */
export function readReply(body: Body): {
	body: string;
	project?: string;
	updateId?: string;
	taskId?: string;
} {
	const input: { body: string; project?: string; updateId?: string; taskId?: string } = {
		body: text(body.body, 'body')
	};
	if ('update' in body) input.updateId = text(body.update, 'update');
	if ('task' in body) input.taskId = text(body.task, 'task');
	if ('project' in body) input.project = text(body.project, 'project');
	return input;
}

/**
 * The query string, as a {@link ThreadQuery}.
 *
 * An absent scope is every message, which is what the whole-timeline page asks
 * for. `limit` is validated here rather than passed through as `NaN`: the domain
 * would refuse it, but with a message about a number the caller never sent.
 */
export function readThreadQuery(url: URL): ThreadQuery {
	const query: ThreadQuery = {};
	const update = url.searchParams.get('update');
	const task = url.searchParams.get('task');
	const project = url.searchParams.get('project');
	const limit = url.searchParams.get('limit');

	if (update) query.updateId = update;
	if (task) query.taskId = task;
	if (project) query.project = project;
	if (limit !== null) {
		if (!/^[0-9]+$/.test(limit)) throw invalid('limit must be a positive integer');
		query.limit = Number(limit);
	}

	return query;
}

function text(value: unknown, field: string): string {
	if (typeof value !== 'string') throw invalid(`${field} must be a string`);
	return value;
}
