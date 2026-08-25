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
import { isDomainError, type Project, type Update } from '$domain';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** Milliseconds since the epoch, as agents should read it. */
function iso(at: number): string {
	return new Date(at).toISOString();
}

/** A successful result: one summary line, then the payload. */
export function ok(summary: string, data: Record<string, unknown>): CallToolResult {
	return {
		content: [{ type: 'text', text: `${summary}\n${JSON.stringify(data, null, 2)}` }],
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

export type ProjectView = {
	id: string;
	slug: string;
	name: string;
	description: string | null;
	status: string;
	pinned: boolean;
	created_at: string;
	updated_at: string;
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
		updated_at: iso(project.updatedAt)
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
		created_at: iso(update.createdAt)
	};
}
