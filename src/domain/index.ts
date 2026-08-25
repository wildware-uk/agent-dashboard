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
/**
 * The row shapes domain functions hand back.
 *
 * Adapters have to be able to *name* what they receive — a formatter needs a
 * type for its argument — and `$mcp` may not import `$db` (design §2). These are
 * types only: the arrow still points one way, and nothing here lets an adapter
 * reach a repository.
 */
export type { Agent, Project, ProjectStatus, Session, SessionMeta, Update, UpdateLevel } from '$db';
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
	AGENT_NAME_MAX_LENGTH,
	TOKEN_BYTES,
	TOKEN_LENGTH,
	authenticateAgent,
	constantTimeEquals,
	hashAgentToken,
	isTokenShaped,
	listAgents,
	mintAgentToken,
	noteAgentSeen,
	revokeAgentToken,
	type AgentAuthFailure,
	type AgentAuthResult,
	type AuthenticateAgentInput,
	type MintAgentTokenInput,
	type MintedAgentToken
} from './agents';
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
	ALLOWED_MIMES,
	FILENAME_MAX_LENGTH,
	MEDIA_PER_UPDATE_MAX,
	MEDIA_SWEEP_INTERVAL_MS,
	UPLOAD_TOKEN_TTL_MS,
	assertAttachable,
	attachMedia,
	checkedMediaIds,
	createUpload,
	ingestUpload,
	readMediaVariant,
	startMediaSweeper,
	sweepMedia,
	type AttachMediaInput,
	type AttachMediaResult,
	type CreateUploadInput,
	type IngestUploadInput,
	type IngestedMedia,
	type MediaSweeperOptions,
	type UploadGrant
} from './media';
export {
	BODY_MAX_LENGTH,
	DEFAULT_LIMIT,
	MAX_LIMIT,
	TITLE_MAX_LENGTH,
	deleteUpdate,
	listUpdates,
	postUpdate,
	setUpdatePinned,
	type ListUpdatesInput,
	type PostUpdateInput,
	type UpdatePage
} from './updates';
export {
	CWD_MAX_LENGTH,
	HEARTBEAT_INTERVAL_S,
	HOST_MAX_LENGTH,
	MODEL_MAX_LENGTH,
	PRESENCE_WINDOW_MS,
	SESSION_IDLE_MS,
	SWEEP_INTERVAL_MS,
	WORK_COUNTERS,
	countWork,
	endSession,
	heartbeat,
	isAgentOnline,
	listLiveAgents,
	registerSession,
	startPresenceSweeper,
	sweepSessions,
	type EndSessionInput,
	type EndSessionResult,
	type Heartbeat,
	type HeartbeatInput,
	type LiveAgent,
	type PresenceSweeperOptions,
	type RegisterSessionInput,
	type RegisteredSession,
	type SweepOptions,
	type SweepResult,
	type WorkCounter,
	type WorkCounts
} from './sessions';
