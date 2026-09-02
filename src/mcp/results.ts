/**
 * Turning domain objects and domain failures into tool results.
 *
 * Every tool answers the same way, because the reader is a language model:
 *
 * - **A sentence first, then JSON.** The sentence is what an agent quotes back
 *   to its user; the JSON is what it parses to get the id it needs next. Both go
 *   in `content[0].text`, and the JSON also goes in `structuredContent` for
 *   clients that read it.
 * - **Field names match the argument names.** Tool arguments are snake_case
 *   (design §5: `media_ids`, `update_id`), so results are too: whatever
 *   `post_update` returns as `project_id` is what `project` accepts back.
 * - **Timestamps are ISO 8601 strings.** The database stores milliseconds, but
 *   an agent reads and reasons about text, and `2026-08-25T09:30:00.000Z` needs
 *   no explanation in a tool description.
 * - **Failures the caller can fix are results, not protocol errors.** A
 *   `DomainError` becomes `isError: true` with its code, which is the difference
 *   between an agent that retries with a corrected argument and one that gives
 *   up on the transport.
 */
import {
	isDomainError,
	type Acknowledgement,
	type Message,
	type OwnerRequest,
	type Project,
	type RequestResult,
	type RequestValue,
	type Task,
	type Update
} from '$domain';
import type { CallToolResult, ContentBlock } from '@modelcontextprotocol/sdk/types.js';

/** Milliseconds since the epoch, as agents should read it. */
function iso(at: number): string {
	return new Date(at).toISOString();
}

/**
 * A successful result: one summary line, then the payload.
 *
 * `extra` is for content the reader has to *see* rather than parse — today the
 * images attached to a message, which cannot travel any other way: an agent has
 * no session cookie and so cannot fetch `/media/...` for itself. The blocks go
 * after the text, so the sentence and the JSON are still the first thing read.
 */
export function ok(
	summary: string,
	data: Record<string, unknown>,
	extra: ContentBlock[] = []
): CallToolResult {
	return {
		content: [{ type: 'text', text: `${summary}\n${JSON.stringify(data, null, 2)}` }, ...extra],
		structuredContent: data
	};
}

/**
 * A failure the caller could act on.
 *
 * `error` is one of the domain's codes (`invalid_argument`, `not_found`,
 * `conflict`) or `internal_error`, and it is stable: a tool description can tell
 * an agent what to do about each one.
 */
export function failed(error: string, message: string): CallToolResult {
	return {
		content: [{ type: 'text', text: `${error}: ${message}` }],
		structuredContent: { error, message },
		isError: true
	};
}

/**
 * Run a tool body and convert anything it throws.
 *
 * A `DomainError` is reported verbatim — the agent asked for something
 * impossible and the message says which part. Anything else is a bug in this
 * server: it is logged so the owner can see it, and the agent is told only that
 * something broke. Echoing an arbitrary stack into a tool result would hand an
 * agent (and its transcript) whatever a `TypeError` happened to be holding.
 */
export function guard(run: () => CallToolResult): CallToolResult {
	try {
		return run();
	} catch (error) {
		if (isDomainError(error)) return failed(error.code, error.message);
		console.error('mcp tool failed', error);
		return failed('internal_error', 'the dashboard failed to handle this call; see server logs');
	}
}

/**
 * `guard`, for the one tool that waits.
 *
 * `request_input` parks on the event bus (design §5), so its body is a promise
 * and the try/catch has to be able to await it. Same conversion, same codes —
 * duplicated as an async twin rather than making every synchronous tool return
 * a promise it does not need.
 */
export async function guarded(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
	try {
		return await run();
	} catch (error) {
		if (isDomainError(error)) return failed(error.code, error.message);
		console.error('mcp tool failed', error);
		return failed('internal_error', 'the dashboard failed to handle this call; see server logs');
	}
}

export type RequestView = {
	id: string;
	kind: string;
	question: string;
	detail: string | null;
	options: string[] | null;
	project_id: string | null;
	update_id: string | null;
	expires_at: string;
};

/** An owner request as a tool reports it back: what was asked, and about what. */
export function requestView(request: OwnerRequest): RequestView {
	return {
		id: request.id,
		kind: request.kind,
		question: request.question,
		detail: request.detail,
		options: request.options,
		project_id: request.projectId,
		update_id: request.updateId,
		expires_at: iso(request.expiresAt)
	};
}

/**
 * The four answers a wait can end with, in the shape design §5 specifies.
 *
 * The summary line is doing real work here: `pending` is the *common* outcome
 * and the one an agent most easily misreads as "no answer, carry on", so the
 * sentence says what to call next, in words, ahead of the JSON. `timeout` and
 * `cancelled` say the opposite of permission for the same reason.
 */
export function requestResult(result: RequestResult): CallToolResult {
	const request = requestView(result.request);

	if (result.state === 'answered') {
		return ok(`Your owner answered: ${describe(result.response.value)}`, {
			state: 'answered',
			request_id: request.id,
			request,
			response: result.response,
			answered_at: iso(result.answeredAt)
		});
	}

	if (result.state === 'pending') {
		return ok(
			`Nobody has answered yet. This is not a refusal — call await_request({request_id: ` +
				`"${request.id}"}) and keep calling it while state is "pending".`,
			{
				state: 'pending',
				request_id: request.id,
				request,
				poll_after_ms: result.pollAfterMs
			}
		);
	}

	const why =
		result.state === 'timeout'
			? 'Nobody answered before this request timed out.'
			: 'Your owner dismissed this request without answering.';

	return ok(`${why} That is not permission: do not proceed as though you had an answer.`, {
		state: result.state,
		request_id: request.id,
		request
	});
}

/** The answer as a sentence, so the model reads it before it parses anything. */
function describe(value: RequestValue): string {
	if (typeof value === 'boolean') return value ? 'yes.' : 'no.';
	if (Array.isArray(value)) {
		return value.length === 0 ? 'nothing.' : value.map((item) => JSON.stringify(item)).join(', ');
	}
	// A form: the action, and whether the text still says what the agent drafted.
	// The text itself is in `response`, which is where an agent must read it —
	// this line is the summary, and repeating a whole Slack message in it would
	// bury the decision the owner actually took.
	if (typeof value === 'object') {
		return `${JSON.stringify(value.action)} on text of ${value.text.length} characters.`;
	}
	return JSON.stringify(value);
}

export type ProjectView = {
	id: string;
	slug: string;
	name: string;
	description: string | null;
	status: string;
	pinned: boolean;
	created_at: string;
	updated_at: string;
	/** Per-project styling (design §7), or `null` for the dashboard's own. */
	theme: { background?: string; accent?: string; logo_media_id?: string } | null;
};

/** A project as a tool reports it. `slug` is what `post_update` takes back. */
export function projectView(project: Project): ProjectView {
	return {
		id: project.id,
		slug: project.slug,
		name: project.name,
		description: project.description,
		status: project.status,
		pinned: project.pinned,
		created_at: iso(project.createdAt),
		updated_at: iso(project.updatedAt),
		theme: themeView(project.theme)
	};
}

/** snake_case on the wire, like every other field an agent reads back. */
function themeView(theme: Project['theme']): ProjectView['theme'] {
	if (!theme) return null;
	return {
		...(theme.background ? { background: theme.background } : {}),
		...(theme.accent ? { accent: theme.accent } : {}),
		...(theme.logoMediaId ? { logo_media_id: theme.logoMediaId } : {})
	};
}

export type UpdateView = {
	id: string;
	project_id: string;
	agent_id: string;
	session_id: string | null;
	title: string | null;
	level: string;
	pinned: boolean;
	/**
	 * Length of the stored body, as a receipt.
	 *
	 * The body itself is not echoed: the agent sent it a moment ago, and a 100k
	 * markdown post coming back is context it already has and pays for twice.
	 */
	body_chars: number;
	created_at: string;
	/** When the agent last corrected it, or `null` if it never has (design §3). */
	edited_at: string | null;
	/** The task this is progress on, or `null` (design §7). */
	task_id: string | null;
};

export function updateView(update: Update): UpdateView {
	return {
		id: update.id,
		project_id: update.projectId,
		agent_id: update.agentId,
		session_id: update.sessionId,
		title: update.title,
		level: update.level,
		pinned: update.pinned,
		body_chars: update.body.length,
		created_at: iso(update.createdAt),
		edited_at: update.editedAt === null ? null : iso(update.editedAt),
		task_id: update.taskId
	};
}

export type TaskView = {
	id: string;
	project_id: string;
	/** The claimant, or the agent the owner targeted it at, or `null`. */
	agent_id: string | null;
	title: string;
	/**
	 * The brief, in full.
	 *
	 * Unlike {@link UpdateView}, which reports only a length, a task's body is the
	 * instruction the agent is about to act on: sending a character count and
	 * making it call a second tool for the words would be a strange economy.
	 */
	body: string;
	state: string;
	created_at: string;
	claimed_at: string | null;
	done_at: string | null;
	/** What the claimant reported when it finished, or `null` while it has not. */
	result: string | null;
	/**
	 * True when the owner offered this task to the project's agents rather than
	 * to one of them.
	 *
	 * A boolean rather than the timestamp behind it: an agent's only decision is
	 * whether to reach for the task, and *when* it was offered is the owner's
	 * question, not the fleet's.
	 */
	broadcast: boolean;
};

/** A task as a tool reports it. `id` is what `claim_task` takes back. */
export function taskView(task: Task): TaskView {
	return {
		id: task.id,
		project_id: task.projectId,
		agent_id: task.agentId,
		title: task.title,
		body: task.body,
		state: task.state,
		created_at: iso(task.createdAt),
		claimed_at: task.claimedAt === null ? null : iso(task.claimedAt),
		done_at: task.doneAt === null ? null : iso(task.doneAt),
		result: task.result,
		broadcast: task.broadcastAt !== null
	};
}

export type MessageView = {
	id: string;
	project_id: string | null;
	update_id: string | null;
	task_id: string | null;
	/** The owner's post this answers, for a reply on a feed post (migration 014). */
	reply_to: string | null;
	/** The literal `human`, or `agent:<agent_id>` (design §3). */
	author: string;
	/** Markdown, as it was written. */
	body: string;
	created_at: string;
	/** When it was unsent (migration 017). Absent for a live message. */
	deleted_at?: string;
};

/**
 * A message as a tool reports it.
 *
 * The body *is* echoed, unlike {@link updateView}'s: this is the one thing the
 * agent did not write and is calling to find out.
 */
export function messageView(message: Message): MessageView {
	return {
		id: message.id,
		project_id: message.projectId,
		update_id: message.updateId,
		task_id: message.taskId,
		reply_to: message.replyTo,
		author: message.author,
		body: message.body,
		created_at: iso(message.createdAt),
		// Absent for a live message, which is almost all of them: a key that said
		// `null` on every message would be noise on every read (migration 017).
		...(message.deletedAt === null ? {} : { deleted_at: iso(message.deletedAt) })
	};
}

/** An acknowledgement as a tool reports it (migration 013). */
export type AckView = {
	id: string;
	/** Exactly one of these two is set: the thing that was acknowledged. */
	message_id: string | null;
	task_id: string | null;
	state: string;
	/** When the agent first said anything about this thing. */
	created_at: string;
	/** When it last changed what it was saying. Equal to `created_at` until it does. */
	updated_at: string;
};

export function ackView(ack: Acknowledgement): AckView {
	return {
		id: ack.id,
		message_id: ack.messageId,
		task_id: ack.taskId,
		state: ack.state,
		created_at: iso(ack.createdAt),
		updated_at: iso(ack.updatedAt)
	};
}
