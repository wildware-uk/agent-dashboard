/**
 * The owner's write calls, from the browser (design §7).
 *
 * The mirror of the store: `timeline.svelte.ts` reads (`GET /api/snapshot`, `GET
 * /api/stream`), this writes (`POST /api/projects`, `PATCH`, `DELETE`). Kept
 * apart from the store on purpose — nothing here touches client state.
 *
 * That is not laziness, it is the design's own consistency rule (§4): the server
 * answers a write, publishes an event, and every open tab — including the one
 * that made the call — hears about it on the stream and refetches. So a control
 * awaits its call, and the row it changed arrives the same way it would have if
 * another tab had done it. There is no optimistic update to reconcile, and no
 * path where the tab that acted disagrees with the tab that watched.
 *
 * The returned row is still handed back, because a control needs to know the
 * call succeeded before it closes its form.
 */
import type { MessageView, ProjectStatus, ProjectView, TaskView, UpdateView } from './types';

/** Just enough of `fetch`. The browser's own satisfies it. */
export type Requester = (url: string, init: RequestInit) => Promise<Response>;

/** What the create form sends. `slug` is derived from the name unless given. */
export type NewProject = {
	name: string;
	description?: string | null;
	slug?: string;
};

/**
 * What the new-task form sends (design §7).
 *
 * `agentId` is the owner targeting one agent — the one place in this product
 * where an agent id is an argument rather than an identity, because the owner is
 * the one saying it and the session cookie is what proves that.
 */
export type NewTask = {
	project: string;
	title: string;
	body?: string | null;
	agentId?: string | null;
};

/**
 * What the owner may change about a task.
 *
 * Two things, and deliberately not the state machine: reassigning it, and
 * cancelling it. Claiming and completing belong to the agent doing the work
 * (design §5), so there is no `state: 'done'` here for a browser to fake.
 */
export type TaskPatch = {
	agentId?: string | null;
	state?: 'cancelled';
};

/**
 * What the reply box sends (design §7).
 *
 * The scope is what the message hangs off — a card, a task, or a project — and
 * exactly one of them is given. There is no `author` field: the owner is the
 * literal `human` and the server decides that from the session cookie, so a
 * browser cannot write a message as anybody else.
 */
export type NewMessage = {
	body: string;
	/** The update being replied to. */
	update?: string;
	task?: string;
	project?: string;
};

/** The fields the owner may change about a project (design §7). */
export type ProjectPatch = {
	name?: string;
	description?: string | null;
	slug?: string;
	status?: ProjectStatus;
	pinned?: boolean;
};

/**
 * A refused write, in one shape whatever refused it.
 *
 * `code` is the domain's own vocabulary where the domain answered
 * (`invalid_argument`, `not_found`, `conflict`), plus two the transport
 * contributes: `unauthenticated` for an expired session and `unreachable` for a
 * request that never arrived. A control can therefore show `message` directly
 * and still branch on `code` when it wants to.
 */
export class ActionError extends Error {
	readonly code: string;
	readonly status: number;

	constructor(code: string, message: string, status: number) {
		super(message);
		this.name = 'ActionError';
		this.code = code;
		this.status = status;
	}
}

export type OwnerActions = {
	createProject(input: NewProject): Promise<ProjectView>;
	patchProject(reference: string, patch: ProjectPatch): Promise<ProjectView>;
	setUpdatePinned(id: string, pinned: boolean): Promise<UpdateView>;
	deleteUpdate(id: string): Promise<UpdateView>;
	createTask(input: NewTask): Promise<TaskView>;
	patchTask(id: string, patch: TaskPatch): Promise<TaskView>;
	postMessage(input: NewMessage): Promise<MessageView>;
};

/**
 * The owner's actions, over a `fetch`.
 *
 * Injectable so a component test can drive a control without a server, and so
 * the two-tab test in `src/http/owner/` can point it straight at the real
 * handlers.
 */
export function ownerActions(request: Requester = defaultRequest): OwnerActions {
	async function send<Key extends 'project' | 'update' | 'task' | 'message'>(
		key: Key,
		url: string,
		method: string,
		body?: unknown
	): Promise<Sent<Key>> {
		const init: RequestInit = { method, headers: { accept: 'application/json' } };
		if (body !== undefined) {
			init.body = JSON.stringify(body);
			init.headers = { ...init.headers, 'content-type': 'application/json' };
		}

		let response: Response;
		try {
			response = await request(url, init);
		} catch {
			// The request never landed: a dropped connection or a server that is
			// down. Not the same as a refusal, and worth saying so, because the
			// answer is "try again" rather than "change what you asked for".
			throw new ActionError('unreachable', 'Could not reach the server. Try again.', 0);
		}

		const payload = await readJson(response);
		if (!response.ok) throw failure(response.status, payload);

		return payload?.[key] as never;
	}

	return {
		createProject: (input) => send('project', '/api/projects', 'POST', input),
		patchProject: (reference, patch) =>
			send('project', `/api/projects/${encodeURIComponent(reference)}`, 'PATCH', patch),
		setUpdatePinned: (id, pinned) =>
			send('update', `/api/updates/${encodeURIComponent(id)}`, 'PATCH', { pinned }),
		deleteUpdate: (id) => send('update', `/api/updates/${encodeURIComponent(id)}`, 'DELETE'),
		createTask: (input) => send('task', '/api/tasks', 'POST', input),
		patchTask: (id, patch) => send('task', `/api/tasks/${encodeURIComponent(id)}`, 'PATCH', patch),
		postMessage: (input) => send('message', '/api/messages', 'POST', input)
	};
}

/** Which row an endpoint answers with, keyed by the field it arrives under. */
type Sent<Key extends 'project' | 'update' | 'task' | 'message'> = Key extends 'project'
	? ProjectView
	: Key extends 'update'
		? UpdateView
		: Key extends 'task'
			? TaskView
			: MessageView;

/**
 * What to show the owner when an action failed.
 *
 * Every control needs this and none of them should decide it: an
 * {@link ActionError} already carries a message written for a person, and
 * anything else that reached a catch block is a bug the owner cannot act on, so
 * it gets a sentence rather than a stack trace.
 */
export function actionMessage(cause: unknown): string {
	if (cause instanceof Error && cause.message.trim() !== '') return cause.message;
	return 'Something went wrong. Try again.';
}

function defaultRequest(url: string, init: RequestInit): Promise<Response> {
	return fetch(url, init);
}

/** A body that is not JSON is not a crash: a proxy error page is still an answer. */
async function readJson(response: Response): Promise<Record<string, unknown> | null> {
	try {
		const parsed: unknown = await response.json();
		return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function failure(status: number, payload: Record<string, unknown> | null): ActionError {
	const code = typeof payload?.error === 'string' ? payload.error : `http_${status}`;
	if (status === 401) {
		// The one refusal the message has to rewrite: the endpoint says
		// `unauthenticated`, which tells the owner nothing about what to do.
		return new ActionError('unauthenticated', 'Your session has expired. Sign in again.', status);
	}

	const message = typeof payload?.message === 'string' ? payload.message : fallback(status);
	return new ActionError(code, message, status);
}

function fallback(status: number): string {
	return status >= 500
		? 'The server could not do that. Try again.'
		: `That was refused (${status}).`;
}
