/**
 * The owner's write endpoints (design §7, §11 step 16).
 *
 * Everything the owner can do to what agents produced: create, rename,
 * re-describe, pin and archive a project; pin or delete an update; put a task on
 * a project, reassign it, or take it back off. The handlers live here rather
 * than in the route files so the whole surface is testable without a server,
 * exactly as `../stream/` is.
 *
 * Three rules hold for all of them:
 *
 * 1. **The domain does the work.** A handler reads the request, calls one domain
 *    function, and serialises what came back. No rule about what a rename means
 *    or when an event is worth publishing lives in this file (design §2), which
 *    is why the browser and an agent over MCP can never disagree about it.
 * 2. **Every write publishes, because the domain publishes.** The event reaches
 *    every open tab over `GET /api/stream`, so a second browser follows a rename
 *    or a delete without being told by this response.
 * 3. **The owner's session is checked here as well as in the hook.** These are
 *    the only endpoints that can destroy something, so they do not rely on
 *    `src/hooks.server.ts` still being wired.
 *
 * Cross-site forgery is handled by the cookie, not by a token here: the session
 * cookie is `SameSite=Lax` (design §8), so a request a third-party page makes to
 * these endpoints arrives with no session and is refused as unauthenticated. That
 * is also why they take JSON rather than a form encoding — a JSON body cannot be
 * sent cross-origin without a preflight the browser will not grant.
 *
 * Only the fields named below are read off a request body. An unknown field is
 * dropped rather than refused: a slightly newer browser tab posting one extra
 * key should not fail, but it must never be able to write a column — `seq`, an
 * `id`, `createdAt` — that only the server gets to decide.
 */
import {
	assignTask,
	cancelTask,
	context,
	createProject,
	createTask,
	deleteUpdate,
	isDomainError,
	invalid,
	setUpdatePinned,
	updateProject,
	type CreateProjectInput,
	type CreateTaskInput,
	type DomainContext,
	type ProjectStatus,
	type UpdateProjectInput
} from '$domain';
import type { AuthConfig, SessionCookieReader } from '../auth';
import { ownerAuthenticated, unauthenticatedResponse } from '../stream';

/** A `DomainError` code is the domain's vocabulary; this is HTTP's (design §2). */
const STATUS_FOR = { invalid_argument: 400, not_found: 404, conflict: 409 } as const;

/** The slice of SvelteKit's `RequestEvent` an owner action needs. */
export type OwnerActionEvent = {
	request: Request;
	/** Route parameters: `reference` for a project, `id` for an update. */
	params: Record<string, string | undefined>;
	cookies: SessionCookieReader;
};

export type OwnerHandlerOptions = {
	/** Injected by tests, which hand over an in-memory database and their own bus. */
	ctx?: () => DomainContext;
	config?: () => AuthConfig | null;
};

export type OwnerHandler = (event: OwnerActionEvent) => Promise<Response>;

/** What every handler returns on success, so one client helper reads them all. */
type Body = Record<string, unknown>;

/** `POST /api/projects` — create a project from the browser (design §7). */
export function createProjectHandler(options: OwnerHandlerOptions = {}): OwnerHandler {
	return handle(options, async (event, ctx) => {
		const input = readCreateProject(await readJson(event.request));
		const { project, created } = createProject(ctx, input);
		// 201 only when this call was the one that created it: `createProject` is
		// idempotent on slug (design §5), and a browser that re-posts a form should
		// be told it got the existing project rather than that it made a new one.
		return { status: created ? 201 : 200, body: { project, created } };
	});
}

/** `PATCH /api/projects/[reference]` — rename, re-describe, pin, archive. */
export function patchProjectHandler(options: OwnerHandlerOptions = {}): OwnerHandler {
	return handle(options, async (event, ctx) => {
		const reference = event.params.reference ?? '';
		const patch = readProjectPatch(await readJson(event.request));
		return { status: 200, body: { project: updateProject(ctx, reference, patch) } };
	});
}

/** `PATCH /api/updates/[id]` — pin or unpin one update. */
export function patchUpdateHandler(options: OwnerHandlerOptions = {}): OwnerHandler {
	return handle(options, async (event, ctx) => {
		const pinned = readUpdatePatch(await readJson(event.request));
		const update = setUpdatePinned(ctx, event.params.id ?? '', pinned);
		return { status: 200, body: { update } };
	});
}

/**
 * `DELETE /api/updates/[id]` — soft delete (design §3).
 *
 * The row survives with `deleted_at` set, which is what lets the browsers that
 * already rendered the card be told to drop it. The confirmation the design asks
 * for is the browser's job: by the time a request reaches here the owner has
 * said yes twice.
 */
export function deleteUpdateHandler(options: OwnerHandlerOptions = {}): OwnerHandler {
	return handle(options, (event, ctx) =>
		Promise.resolve({ status: 200, body: { update: deleteUpdate(ctx, event.params.id ?? '') } })
	);
}

/**
 * `POST /api/tasks` — the owner puts work on a project (design §7).
 *
 * `agentId` is an argument here and nowhere in `$mcp`, and the difference is the
 * whole point: an agent's identity comes from its token so that one agent cannot
 * act as another, while *assigning* work to an agent is something only the owner
 * does — and the session cookie is what proves the caller is the owner.
 */
export function createTaskHandler(options: OwnerHandlerOptions = {}): OwnerHandler {
	return handle(options, async (event, ctx) => {
		const input = readCreateTask(await readJson(event.request));
		return { status: 201, body: { task: createTask(ctx, input) } };
	});
}

/**
 * `PATCH /api/tasks/[id]` — reassign one task, or cancel it.
 *
 * Those are the only two, and the omissions are deliberate: `claimed` and `done`
 * are the agent's to write over MCP (design §5), so a browser cannot mark work
 * finished that nobody did. A patch naming any other state is refused rather
 * than quietly ignored.
 */
export function patchTaskHandler(options: OwnerHandlerOptions = {}): OwnerHandler {
	return handle(options, async (event, ctx) => {
		const id = event.params.id ?? '';
		const patch = readTaskPatch(await readJson(event.request));
		const task = patch.cancel ? cancelTask(ctx, id) : assignTask(ctx, id, patch.agentId);
		return { status: 200, body: { task } };
	});
}

/**
 * Auth, then the action, then the error mapping. Written once because every
 * handler needs all three in the same order, and one that skipped the first
 * would be a hole in the only lock that matters here.
 */
function handle(
	options: OwnerHandlerOptions,
	run: (event: OwnerActionEvent, ctx: DomainContext) => Promise<{ status: number; body: Body }>
): OwnerHandler {
	return async (event) => {
		if (!ownerAuthenticated(event, options.config)) return unauthenticatedResponse();

		try {
			const ctx = options.ctx ? options.ctx() : context();
			const { status, body } = await run(event, ctx);
			return json(status, body);
		} catch (error) {
			if (!isDomainError(error)) throw error;
			return json(STATUS_FOR[error.code], { error: error.code, message: error.message });
		}
	};
}

/**
 * The request body as an object.
 *
 * A body that is not a JSON object becomes an `invalid_argument`, not a 500:
 * a malformed request is the caller's mistake, and it is the same mistake
 * whether it arrived as `name=dash`, as `null`, or as an array.
 */
async function readJson(request: Request): Promise<Body> {
	let parsed: unknown;
	try {
		parsed = await request.json();
	} catch {
		throw invalid('body must be JSON');
	}

	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw invalid('body must be a JSON object');
	}
	return parsed as Body;
}

/** The create form: a name, and optionally a description and an explicit slug. */
export function readCreateProject(body: Body): CreateProjectInput {
	const input: CreateProjectInput = { name: text(body.name, 'name') };
	if ('description' in body) input.description = nullableText(body.description, 'description');
	if ('slug' in body) input.slug = text(body.slug, 'slug');
	return input;
}

/**
 * The five things the owner may change about a project.
 *
 * An empty patch is passed straight through to the domain, which refuses it —
 * the reason lives there (it would publish an event that told every browser to
 * re-render for nothing), so it is not restated as a second rule here.
 */
export function readProjectPatch(body: Body): UpdateProjectInput {
	const patch: UpdateProjectInput = {};
	if ('name' in body) patch.name = text(body.name, 'name');
	if ('description' in body) patch.description = nullableText(body.description, 'description');
	if ('slug' in body) patch.slug = text(body.slug, 'slug');
	if ('status' in body) patch.status = status(body.status);
	if ('pinned' in body) patch.pinned = flag(body.pinned, 'pinned');
	return patch;
}

/**
 * The one thing the owner may change about an update.
 *
 * Deliberately not a patch object: an update is what an agent reported, and the
 * owner curates it rather than editing it. Anything but `pinned` is refused
 * outright so that a body someone hopefully sent — a rewritten `body`, a
 * different `level` — cannot be silently dropped and reported as a success.
 */
export function readUpdatePatch(body: Body): boolean {
	const keys = Object.keys(body);
	if (keys.length !== 1 || keys[0] !== 'pinned') {
		throw invalid('an update patch changes pinned and nothing else');
	}
	return flag(body.pinned, 'pinned');
}

/** The new-task form: a project, a title, and optionally a brief and an assignee. */
export function readCreateTask(body: Body): CreateTaskInput {
	const input: CreateTaskInput = {
		project: text(body.project, 'project'),
		title: text(body.title, 'title')
	};
	if ('body' in body) input.body = nullableText(body.body, 'body');
	if ('agentId' in body) input.agentId = nullableText(body.agentId, 'agentId');
	return input;
}

/** What a task patch resolved to: a cancel, or an assignee to write. */
export type TaskPatch = { cancel: true } | { cancel: false; agentId: string | null };

/**
 * The two things the owner may do to an existing task.
 *
 * One at a time, and named explicitly. A patch carrying both would have to pick
 * an order, and a patch carrying neither is a click that would publish an event
 * telling every open tab to re-render for nothing.
 */
export function readTaskPatch(body: Body): TaskPatch {
	if ('state' in body) {
		if (body.state !== 'cancelled') {
			throw invalid('the only state the owner may set is cancelled; agents claim and complete');
		}
		if ('agentId' in body) throw invalid('cancel a task or reassign it, not both');
		return { cancel: true };
	}

	if ('agentId' in body) return { cancel: false, agentId: nullableText(body.agentId, 'agentId') };
	throw invalid('a task patch either reassigns the task or cancels it');
}

function text(value: unknown, field: string): string {
	if (typeof value !== 'string') throw invalid(`${field} must be a string`);
	return value;
}

function nullableText(value: unknown, field: string): string | null {
	if (value === null) return null;
	return text(value, field);
}

function flag(value: unknown, field: string): boolean {
	if (typeof value !== 'boolean') throw invalid(`${field} must be true or false`);
	return value;
}

function status(value: unknown): ProjectStatus {
	if (value !== 'active' && value !== 'archived') {
		throw invalid('status must be active or archived');
	}
	return value;
}

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'content-type': 'application/json; charset=utf-8',
			// A write's answer is never re-servable.
			'cache-control': 'no-store'
		}
	});
}

/**
 * The two pieces an owner endpoint that lives in its own file needs.
 *
 * `messages.ts` is such a file (the reply box's endpoints, #14): the wrapper
 * above is the *only* lock on these routes, so it is shared rather than
 * reimplemented — a second copy is a second chance to forget the auth check.
 */
export { handle as ownerAction, readJson as readOwnerJson };
