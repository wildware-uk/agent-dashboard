/**
 * Public entry point for the business rules.
 *
 * `$mcp` and `$http` both call in here and nowhere deeper, which is what keeps
 * the two front doors behaviourally identical.
 *
 * The shape every function in here follows (design §2):
 *
 * ```ts
 * import { context, createProject, postUpdate } from '$domain';
 *
 * const ctx = context();
 * const { project, created } = createProject(ctx, { name: 'Agent Dashboard' });
 * const update = postUpdate(ctx, { project: project.slug, agentId, body: '# shipped' });
 * ```
 *
 * `ctx` first, then plain arguments; plain objects out; a `DomainError` with a
 * `code` for anything the caller could have avoided; exactly one event on the
 * bus per write. No HTTP or MCP type appears anywhere in this module.
 *
 * `./testing.ts` is a second, test-only entry point and is not re-exported here.
 */
export { context, type Clock, type DomainContext } from './context';
export {
	DomainError,
	conflict,
	invalid,
	isDomainError,
	notFound,
	type DomainErrorCode
} from './errors';
export { SLUG_MAX_LENGTH, SLUG_PATTERN, assertSlug, isSlug, slugFor, slugify } from './slug';
export {
	DESCRIPTION_MAX_LENGTH,
	NAME_MAX_LENGTH,
	createProject,
	findProject,
	listProjects,
	resolveProject,
	updateProject,
	type CreateProjectInput,
	type CreateProjectResult,
	type UpdateProjectInput
} from './projects';
export {
	BODY_MAX_LENGTH,
	DEFAULT_LIMIT,
	MAX_LIMIT,
	TITLE_MAX_LENGTH,
	deleteUpdate,
	listUpdates,
	postUpdate,
	type ListUpdatesInput,
	type PostUpdateInput,
	type UpdatePage
} from './updates';
