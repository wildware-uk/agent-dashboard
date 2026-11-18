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
import { outgoing, type OutgoingMessages } from './outgoing';
import type {
	MediaView,
	MessageView,
	ReactionView,
	ProjectStatus,
	ProjectView,
	RequestFormValue,
	TaskState,
	CardFieldView,
	RequestView,
	TagView,
	UpdateView
} from './types';
import { canReportProgress, putBytes, UploadUnreachable, type UploadProgress } from './bytes';
export type { UploadProgress } from './bytes';

/** Just enough of `fetch`. The browser's own satisfies it. */
export type Requester = (url: string, init: RequestInit) => Promise<Response>;

/** What the create form sends. `slug` is derived from the name unless given. */
export type NewProject = {
	name: string;
	description?: string | null;
	slug?: string;
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
	 * A comment in the thread this message answers (migration 020).
	 *
	 * The reply still belongs to whatever thread it was written in — this only
	 * says which line it is addressed to, so a card carrying two conversations
	 * can be read without nesting anything.
	 */
	answers?: string;
	/**
	 * The question being talked over rather than answered (migration 032).
	 *
	 * The owner: "allow me to reply to form questions, so I can discuss with the
	 * agent before giving the answer." A request's discussion is its own thread,
	 * so this is the whole anchor — no card, no project.
	 */
	request?: string;
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

/** The four things that appear in the feed (migration 034). */
export type CardKind = 'update' | 'message' | 'request' | 'task';

export type OwnerActions = {
	createProject(input: NewProject): Promise<ProjectView>;
	patchProject(reference: string, patch: ProjectPatch): Promise<ProjectView>;
	/**
	 * Pin any card to the top of the feed, or unpin it (migration 034).
	 *
	 * The owner: "let me pin my own messages." Pinning was an update's alone
	 * because updates were the only cards when it was written; it is a thing you
	 * do to a card, so it takes a card.
	 *
	 * Nothing is changed here — the server publishes, the tab hears the card's own
	 * updated event and refetches, so every window agrees.
	 */
	pinCard(kind: CardKind, id: string, pinned: boolean): Promise<void>;
	/**
	 * Mark a card as work, move it along, or stop calling it work
	 * (migration 035).
	 *
	 * The owner: "instead agents can mark a card in the feed as a task, and
	 * update the status of the card." `null` clears it.
	 *
	 * Nothing is changed here — the server publishes, the tab hears the card's
	 * own updated event and refetches, so every window agrees.
	 */
	setCardStatus(kind: CardKind, id: string, status: string | null): Promise<void>;
	/**
	 * Put one of the project's words on a card, or take it off (migration 039).
	 *
	 * The picker holds the list, so this sends an id; `create` is for the "new
	 * tag…" box, where the word is typed and the project may not have it yet.
	 * Nothing is changed here — the server publishes and the tab refetches.
	 */
	tagCard(kind: CardKind, id: string, tag: string, on?: boolean, create?: boolean): Promise<void>;
	/**
	 * Note something on a card, correct it, or take it off (migration 040).
	 *
	 * `null` removes. Nobody owns a field — the owner may correct an agent's and
	 * the other way round — so this is a plain write with no ownership check.
	 */
	setCardField(kind: CardKind, id: string, name: string, value: string | null): Promise<void>;
	/**
	 * Keep what an app saved for itself (migration 041).
	 *
	 * An app runs in a frame with no same-origin privileges, so it has no storage
	 * of its own: the open tab and the half-filled form live here instead. It is
	 * deliberately not announced on the stream — two tabs disagreeing about which
	 * section is open is better than every tab redrawing because one was opened.
	 */
	saveAppState(viewId: string, state: Record<string, unknown> | null): Promise<void>;
	/** Decide a new word for a project (migration 039). */
	defineTag(project: string, name: string, colour?: string | null): Promise<TagView>;
	/** Rename a word, or recolour it, on every card carrying it. */
	renameTag(id: string, patch: { name?: string; colour?: string | null }): Promise<TagView>;
	/** Retire a word, taking it off every card. */
	retireTag(id: string): Promise<void>;
	setUpdatePinned(id: string, pinned: boolean): Promise<UpdateView>;
	deleteUpdate(id: string): Promise<UpdateView>;
	/**
	 * Upload one image and get the row back (migration 016).
	 *
	 * One request per file, bytes in the body: the browser already carries the
	 * session cookie, so there is nothing for a token to authorise that the
	 * request does not already prove. The id comes back unattached — hold it and
	 * send it with the message, exactly as an agent does between `create_upload`
	 * and `post_message`.
	 *
	 * `onProgress` is called as the bytes leave, so the box can show a bar rather
	 * than a dimmed thumbnail and no news. It is optional and best-effort: an
	 * environment with no `XMLHttpRequest` still uploads, it just never reports.
	 */
	uploadMedia(file: File, onProgress?: UploadProgress): Promise<MediaView>;
	/**
	 * Rename an agent, leaving its token alone.
	 *
	 * A name was fixed when the token was minted, so correcting one meant
	 * minting a new token and rewriting the config of whichever machine held
	 * it. The identity does not move: every card that agent ever posted simply
	 * starts reading the new name.
	 */
	renameAgent(id: string, name: string): Promise<{ id: string; name: string }>;
	postMessage(input: NewMessage): Promise<MessageView>;
	/**
	 * Delete a message: one of the owner's own posts, a reply, or an agent's
	 * line in a thread (migration 017).
	 *
	 * Nothing is removed here. The server soft-deletes and publishes, the tab
	 * hears `message.deleted` and refetches, so the line goes from every open
	 * window by the same route — there is no optimistic removal that could
	 * disagree with a delete that failed.
	 *
	 * Deleting a post takes its replies with it, which is why the control asks
	 * before it fires.
	 */
	deleteMessage(id: string): Promise<MessageView>;
	/**
	 * React to a message, or take a reaction back (migration 024).
	 *
	 * Toggling: the same emoji twice is off again, which is what clicking one
	 * means. Nothing is changed here — the server publishes, the tab hears
	 * `reaction.updated` and refetches, so every window agrees.
	 */
	react(id: string, emoji: string, on?: boolean): Promise<ReactionView[]>;
	/**
	 * React to any card, or take a reaction back (migration 034).
	 *
	 * The same toggle {@link OwnerActions.react} has, addressed by card rather
	 * than by message: an emoji on an update is the same act as an emoji on a
	 * reply, and the owner asked for the cards to stop differing.
	 */
	reactToCard(kind: CardKind, id: string, emoji: string, on?: boolean): Promise<ReactionView[]>;
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
 *
 * Every message it posts is announced on `messages` (`./outgoing.ts`), so the
 * thread store can show it at once rather than when the stream echoes it.
 */
export function ownerActions(
	request: Requester = defaultRequest,
	messages: OutgoingMessages = outgoing
): OwnerActions {
	async function send<
		Key extends
			| 'project'
			| 'update'
			| 'message'
			| 'request'
			| 'agent'
			| 'reactions'
			| 'pinned'
			| 'status'
			| 'tag'
			| 'fields'
	>(key: Key, url: string, method: string, body?: unknown): Promise<Sent<Key>> {
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
	/**
	 * The type to declare for a chosen file.
	 *
	 * A browser guesses from the extension and answers `''` when it cannot — a
	 * `.log`, a `.lock`, anything without a registered extension — and an empty
	 * `Content-Type` is a request whose body the server discards. So the fallback
	 * is the type that means "bytes": the server stores it as a file either way,
	 * and a wrong label on a download costs nothing (migration 026).
	 */
	function fileType(file: File): string {
		return file.type && file.type.trim() !== '' ? file.type : 'application/octet-stream';
	}

	async function sendBytes(
		url: string,
		file: File,
		onProgress?: UploadProgress
	): Promise<MediaView> {
		// `fetch` has no upload progress event, so a watched upload goes over
		// `XMLHttpRequest` instead (see `./bytes.ts`). The `fetch` path below is
		// what runs when nobody is watching, and in a test that injected its own
		// requester — swapping that out for XHR would make an injected `request`
		// silently ignored.
		if (onProgress && canReportProgress()) {
			let outcome;
			try {
				outcome = await putBytes({
					url,
					file,
					contentType: fileType(file),
					onProgress
				});
			} catch (cause) {
				if (cause instanceof UploadUnreachable) {
					throw new ActionError('unreachable', 'Could not reach the server. Try again.', 0);
				}
				throw cause;
			}

			if (!outcome.ok) throw failure(outcome.status, outcome.body);
			return (outcome.body as { media: MediaView }).media;
		}

		let response: Response;
		try {
			response = await request(url, {
				method: 'POST',
				headers: { accept: 'application/json', 'content-type': fileType(file) },
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
	async function json<Result>(url: string, method: string, body?: unknown): Promise<Result> {
		const init: RequestInit = { method, headers: { accept: 'application/json' } };
		if (body !== undefined) {
			init.body = JSON.stringify(body);
			init.headers = { ...init.headers, 'content-type': 'application/json' };
		}

		let response: Response;
		try {
			response = await request(url, init);
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
		pinCard: async (kind, id, pinned) => {
			await send(
				'pinned',
				`/api/cards/${encodeURIComponent(kind)}/${encodeURIComponent(id)}/pin`,
				'POST',
				{ pinned }
			);
		},
		setCardStatus: async (kind, id, status) => {
			await send(
				'status',
				`/api/cards/${encodeURIComponent(kind)}/${encodeURIComponent(id)}/status`,
				'POST',
				{ status }
			);
		},
		tagCard: async (kind, id, tag, on, create) => {
			await send(
				'tag',
				`/api/cards/${encodeURIComponent(kind)}/${encodeURIComponent(id)}/tags`,
				'POST',
				{
					tag,
					...(typeof on === 'boolean' ? { on } : {}),
					...(create ? { create: true } : {})
				}
			);
		},
		setCardField: async (kind, id, name, value) => {
			await send(
				'fields',
				`/api/cards/${encodeURIComponent(kind)}/${encodeURIComponent(id)}/fields`,
				'POST',
				{ name, value }
			);
		},
		saveAppState: async (viewId, state) => {
			await json(`/api/apps/${encodeURIComponent(viewId)}/state`, 'POST', { state });
		},
		defineTag: (project, name, colour) =>
			send('tag', `/api/projects/${encodeURIComponent(project)}/tags`, 'POST', {
				name,
				...(colour === undefined ? {} : { colour })
			}),
		renameTag: (id, patch) => send('tag', `/api/tags/${encodeURIComponent(id)}`, 'PATCH', patch),
		retireTag: async (id) => {
			await send('tag', `/api/tags/${encodeURIComponent(id)}`, 'DELETE');
		},
		setUpdatePinned: (id, pinned) =>
			send('update', `/api/updates/${encodeURIComponent(id)}`, 'PATCH', { pinned }),
		deleteUpdate: (id) => send('update', `/api/updates/${encodeURIComponent(id)}`, 'DELETE'),
		uploadMedia: (file, onProgress) =>
			sendBytes(
				`/api/media?filename=${encodeURIComponent(file.name || 'upload')}`,
				file,
				onProgress
			),
		renameAgent: (id, name) =>
			send('agent', `/api/agents/${encodeURIComponent(id)}`, 'PATCH', { name }),
		postMessage: async (input) => {
			const ticket = messages.begin(input);
			try {
				const stored = await send('message', '/api/messages', 'POST', input);
				messages.sent(ticket, stored);
				return stored;
			} catch (cause) {
				messages.failed(ticket);
				throw cause;
			}
		},
		deleteMessage: (id) => send('message', `/api/messages/${encodeURIComponent(id)}`, 'DELETE'),
		react: (id, emoji, on) =>
			send('reactions', `/api/messages/${encodeURIComponent(id)}/reactions`, 'POST', {
				emoji,
				...(on === undefined ? {} : { on })
			}),
		reactToCard: (kind, id, emoji, on) =>
			send(
				'reactions',
				`/api/cards/${encodeURIComponent(kind)}/${encodeURIComponent(id)}/reactions`,
				'POST',
				{ emoji, ...(on === undefined ? {} : { on }) }
			),
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
type Sent<
	Key extends
		| 'project'
		| 'update'
		| 'message'
		| 'request'
		| 'agent'
		| 'reactions'
		| 'pinned'
		| 'status'
		| 'tag'
		| 'fields'
> = Key extends 'pinned'
	? boolean
	: Key extends 'status'
		? string | null
		: Key extends 'tag'
			? TagView
			: Key extends 'fields'
				? CardFieldView[]
				: Key extends 'project'
					? ProjectView
					: Key extends 'update'
						? UpdateView
						: Key extends 'request'
							? RequestView
							: Key extends 'agent'
								? { id: string; name: string }
								: // The reaction endpoint answers with the whole list on the message
									// rather than the one row that changed: a count is what the card
									// renders, and asking for it separately would be a second request.
									Key extends 'reactions'
									? ReactionView[]
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
