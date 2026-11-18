/**
 * The owner's write endpoints (design §7, §11 step 16).
 *
 * Everything the owner can do to what agents produced: create, rename,
 * re-describe, pin and archive a project; pin, fold, mark or delete a card;
 * answer a question. The handlers live here rather than in the route files so
 * the whole surface is testable without a server, exactly as `../stream/` is.
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
	context,
	createProject,
	deleteUpdate,
	isDomainError,
	invalid,
	renameAgent,
	setUpdatePinned,
	updateProject,
	type CreateProjectInput,
	type DomainContext,
	type ProjectStatus,
	type ProjectThemeInput,
	type UpdateProjectInput
} from '$domain';
import type { AuthConfig, SessionCookieReader } from '../auth';
import { ownerAuthenticated, unauthenticatedResponse, type DeviceResolver } from '../stream';

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
	/** Resolves one of the owner's phones from its bearer key. */
	devices?: DeviceResolver;
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
 * `PATCH /api/agents/[id]` — give an agent a name the owner will recognise.
 *
 * The token is untouched. A name was fixed at `mint-token` time, so correcting
 * one meant minting a new token and rewriting the MCP config of whichever
 * machine held it — a lot of ceremony for a label, and the reason so many
 * deployments are full of agents called `claude-code@laptop`.
 */
export function renameAgentHandler(options: OwnerHandlerOptions = {}): OwnerHandler {
	return handle(options, async (event, ctx) => {
		const name = readAgentPatch(await readJson(event.request));
		const agent = renameAgent(ctx, event.params.id ?? '', name);

		// The id and the new name, and nothing else. The row carries `tokenHash`,
		// and while an HMAC is not a token, this codebase's rule is that it never
		// leaves the database (design §8) — a browser has no use for it, and a
		// response is the easiest place for it to end up somewhere it should not.
		return { status: 200, body: { agent: { id: agent.id, name: agent.name } } };
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
		if (!ownerAuthenticated(event, options.config, options.devices)) {
			return unauthenticatedResponse();
		}

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
	if ('theme' in body) patch.theme = themePatch(body.theme);
	// Passed through untouched: `$domain` is the one place that decides what a
	// board may be, and a second shape check here would be a weaker copy of it.
	if ('board' in body) patch.board = body.board;
	return patch;
}

/**
 * The theme half of a project patch (design §7).
 *
 * Only the three fields are read, and each only as a string or `null` — the
 * values are checked properly in `$domain`, which is the one place that decides
 * what may reach a CSS custom property. This is the shape check that keeps an
 * object or an array from getting that far.
 */
function themePatch(value: unknown): ProjectThemeInput | null {
	if (value === null) return null;
	if (typeof value !== 'object' || Array.isArray(value)) {
		throw invalid('theme must be an object, or null to clear it');
	}

	const body = value as Record<string, unknown>;
	const patch: ProjectThemeInput = {};
	if ('background' in body) patch.background = nullableText(body.background, 'background');
	if ('accent' in body) patch.accent = nullableText(body.accent, 'accent');
	if ('logoMediaId' in body) patch.logoMediaId = nullableText(body.logoMediaId, 'logoMediaId');
	if ('logoReplacesName' in body) {
		patch.logoReplacesName =
			body.logoReplacesName === null ? null : flag(body.logoReplacesName, 'logoReplacesName');
	}
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

/**
 * The one thing the owner may change about an agent.
 *
 * Deliberately not a patch object: an agent's identity is its token, and the
 * only part of it the owner authors is what they call it. Anything else sent
 * here is refused outright rather than dropped, so a hopeful `tokenHash` fails
 * loudly instead of appearing to work.
 */
export function readAgentPatch(body: Body): string {
	const keys = Object.keys(body);
	if (keys.length !== 1 || keys[0] !== 'name') {
		throw invalid('an agent patch changes name and nothing else');
	}
	return text(body.name, 'name');
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
