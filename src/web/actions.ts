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
import type {
	MediaView,
	MessageView,
	ProjectStatus,
	ProjectView,
	RequestFormValue,
	TaskState,
	RequestView,
	TaskView,
	UpdateView
} from './types';

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
	/**
	 * Hand it to the project's agents as it is created.
	 *
	 * What the board's composer sends: no assignee, offered to everybody, first
	 * to claim takes it. Refused alongside `agentId`.
	 */
	broadcast?: boolean;
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
	/**
	 * Offer this task to the project's agents, or take it back off the wire.
	 *
	 * Not an assignment: an assignment names who must do it, this says whoever
	 * gets there first. The server refuses more than one of the three at a time,
	 * so a caller sends exactly one field.
	 */
	broadcast?: boolean;
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
	/**
	 * The owner's own feed post being replied to (migration 014).
	 *
	 * A post anchors to nothing else — it is the thing being discussed — so a
	 * reply names it directly. Exactly one anchor, or none for a project note.
	 */
	replyTo?: string;
	/**
	 * Images already uploaded with {@link OwnerActions.uploadMedia}.
	 *
	 * Ids, not bytes: the upload is its own request, so a slow picture never
	 * holds up the words and a failed one is reported before anything is posted.
	 */
	mediaIds?: string[];
};

/** The fields the owner may change about a project (design §7). */
export type ProjectPatch = {
	name?: string;
	description?: string | null;
	slug?: string;
	status?: ProjectStatus;
	pinned?: boolean;
	/**
	 * Per-project styling (design §7). Merged field by field with what the project
	 * already has; `null` clears the whole theme.
	 */
	theme?: {
		background?: string | null;
		accent?: string | null;
		logoMediaId?: string | null;
		logoReplacesName?: boolean | null;
	} | null;
	/**
	 * The task board's columns (design §7).
	 *
	 * Replaced wholesale rather than merged: a board is an ordered list and the
	 * caller always sends the arrangement it wants. `null` restores the default.
	 */
	board?: { columns: { title: string; states: TaskState[] }[] } | null;
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
	/**
	 * Record that the owner has opened a project, clearing its "new" badge.
	 *
	 * Fire-and-forget from the caller's point of view — the badge is a
	 * convenience, and a failed stamp costs a count that clears on the next
	 * visit rather than anything the owner has to redo.
	 */
	markProjectSeen(reference: string): Promise<ProjectView>;
	/**
	 * Record that the owner has read one card's thread (migration 015).
	 *
	 * What lets a card leave "Recent replies" and drop back into its day.
	 */
	markRepliesSeen(id: string): Promise<UpdateView>;
	/**
	 * Upload one image and get the row back (migration 016).
	 *
	 * One request per file, bytes in the body: the browser already carries the
	 * session cookie, so there is nothing for a token to authorise that the
	 * request does not already prove. The id comes back unattached — hold it and
	 * send it with the message, exactly as an agent does between `create_upload`
	 * and `post_message`.
	 */
	uploadMedia(file: File): Promise<MediaView>;
	postMessage(input: NewMessage): Promise<MessageView>;
	/**
	 * Answer an agent's request (design §5).
	 *
	 * `value` is sent exactly as the control produced it — a string, a boolean or
	 * a list — and is checked against the request server-side. The browser does
	 * not get to decide what a valid answer is, so nothing here reshapes it.
	 */
	answerRequest(
		id: string,
		value: string | boolean | string[] | RequestFormValue
	): Promise<RequestView>;
	/**
	 * Publish one card and return the link (design §7, §8).
	 *
	 * The URL comes back exactly once, from this call. The server keeps only an
	 * HMAC of the token, so nothing can hand it over again — sharing a card that
	 * is already shared mints a new link and retires the old one.
	 */
	shareUpdate(id: string): Promise<{ url: string }>;
	/** Stop the link working. `revoked` is false if there was nothing live. */
	revokeShare(id: string): Promise<{ revoked: boolean }>;
	/** Dismiss it without answering: the agent is told `cancelled`. */
	dismissRequest(id: string): Promise<RequestView>;
};

/**
 * The owner's actions, over a `fetch`.
 *
 * Injectable so a component test can drive a control without a server, and so
 * the two-tab test in `src/http/owner/` can point it straight at the real
 * handlers.
 */
export function ownerActions(request: Requester = defaultRequest): OwnerActions {
	async function send<Key extends 'project' | 'update' | 'task' | 'message' | 'request'>(
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

	/**
	 * One file, as raw bytes.
	 *
	 * Not `send`: that one is for JSON bodies, and a multipart wrapper here would
	 * be a second encoding for the server to unwrap when the browser can simply
	 * put the file on the request. `Content-Type` is the file's own, which is
	 * also what the server checks the bytes against.
	 */
	async function sendBytes(url: string, file: File): Promise<MediaView> {
		let response: Response;
		try {
			response = await request(url, {
				method: 'POST',
				headers: { accept: 'application/json', 'content-type': file.type },
				body: file
			});
		} catch {
			throw new ActionError('unreachable', 'Could not reach the server. Try again.', 0);
		}

		const payload = await readJson(response);
		if (!response.ok) throw failure(response.status, payload);

		return (payload as { media: MediaView }).media;
	}

	/**
	 * The same request, returning the whole body.
	 *
	 * {@link send} plucks one row out by key, which is right for every endpoint
	 * that answers with a row. The share endpoints do not: one answers with a URL
	 * that exists nowhere else, the other with whether anything was live.
	 */
	async function json<Result>(url: string, method: string): Promise<Result> {
		let response: Response;
		try {
			response = await request(url, { method, headers: { accept: 'application/json' } });
		} catch {
			throw new ActionError('unreachable', 'Could not reach the server. Try again.', 0);
		}

		const payload = await readJson(response);
		if (!response.ok) throw failure(response.status, payload);

		return payload as Result;
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
		markProjectSeen: (reference) =>
			send('project', `/api/projects/${encodeURIComponent(reference)}/seen`, 'POST'),
		markRepliesSeen: (id) =>
			send('update', `/api/updates/${encodeURIComponent(id)}/replies-seen`, 'POST'),
		uploadMedia: (file) =>
			sendBytes(`/api/media?filename=${encodeURIComponent(file.name || 'upload')}`, file),
		postMessage: (input) => send('message', '/api/messages', 'POST', input),
		answerRequest: (id, value) =>
			send('request', `/api/requests/${encodeURIComponent(id)}/answer`, 'POST', { value }),
		dismissRequest: (id) => send('request', `/api/requests/${encodeURIComponent(id)}`, 'DELETE'),
		// Not through `send`: these two answer with their own shapes rather than
		// with a row, because a link is not a row and "was one live" is not one
		// either.
		shareUpdate: (id) => json(`/api/updates/${encodeURIComponent(id)}/share`, 'POST'),
		revokeShare: (id) => json(`/api/updates/${encodeURIComponent(id)}/share`, 'DELETE')
	};
}

/** Which row an endpoint answers with, keyed by the field it arrives under. */
type Sent<Key extends 'project' | 'update' | 'task' | 'message' | 'request'> = Key extends 'project'
	? ProjectView
	: Key extends 'update'
		? UpdateView
		: Key extends 'task'
			? TaskView
			: Key extends 'request'
				? RequestView
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
