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
export type {
	AckState,
	Acknowledgement,
	Agent,
	Message,
	Project,
	ProjectStatus,
	Session,
	SessionMeta,
	Task,
	TaskState,
	Update,
	UpdateLevel
} from '$db';
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
	listAgentNames,
	listAgents,
	mintAgentToken,
	noteAgentSeen,
	renameAgent,
	revokeAgentToken,
	type AgentAuthFailure,
	type AgentAuthResult,
	type AuthenticateAgentInput,
	type MintAgentTokenInput,
	type MintedAgentToken
} from './agents';
export {
	ACK_STATES,
	acknowledge,
	acknowledgementsFor,
	type AcknowledgeInput,
	type AcknowledgementScope
} from './acknowledgements';
export {
	DESCRIPTION_MAX_LENGTH,
	NAME_MAX_LENGTH,
	createProject,
	findProject,
	listProjects,
	markProjectSeen,
	resolveProject,
	unseenUpdateCounts,
	BOARD_COLUMNS_MAX,
	COLUMN_TITLE_MAX_LENGTH,
	DEFAULT_BOARD,
	THEME_COLOUR,
	assertBoard,
	mergeTheme,
	updateProject,
	type CreateProjectInput,
	type CreateProjectResult,
	type ProjectThemeInput,
	type UpdateProjectInput
} from './projects';
export {
	ALLOWED_MIMES,
	assertAttachableToMessage,
	listMessageMedia,
	uploadOwnerMedia,
	FILENAME_MAX_LENGTH,
	MEDIA_PER_UPDATE_MAX,
	MEDIA_SWEEP_INTERVAL_MS,
	UPLOAD_TOKEN_TTL_MS,
	assertAttachable,
	attachMedia,
	checkedMediaIds,
	createUpload,
	ingestUpload,
	listUpdateMedia,
	readMediaVariant,
	startMediaSweeper,
	sweepMedia,
	type AttachMediaInput,
	type AttachMediaResult,
	type CreateUploadInput,
	type IngestUploadInput,
	type IngestedMedia,
	type MediaAttachment,
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
	markRepliesSeen,
	postUpdate,
	editUpdate,
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
export {
	AGENT_AUTHOR_PREFIX,
	DEFAULT_MESSAGE_LIMIT,
	HUMAN_AUTHOR,
	MAX_MESSAGE_LIMIT,
	MESSAGE_BODY_MAX_LENGTH,
	authorText,
	countUnreadMessages,
	alreadyDelivered,
	countUnreadMessagesInScope,
	deleteMessage,
	deliveriesFor,
	markMessagesDelivered,
	projectsForAgent,
	unreadMessagesInScope,
	listThread,
	parseAuthor,
	postMessage,
	readMessages,
	type DeleteMessageInput,
	type MessageAuthor,
	type MessagePage,
	type PostMessageInput,
	type ReadMessagesInput,
	type ThreadQuery
} from './messages';
export {
	DEFAULT_HOLD_MS,
	DEFAULT_TIMEOUT_S,
	DETAIL_MAX_LENGTH,
	MAX_TIMEOUT_S,
	MIN_TIMEOUT_S,
	OPTIONS_MAX,
	OPTION_MAX_LENGTH,
	PENDING_REQUEST_LIMIT,
	POLL_AFTER_MS,
	QUESTION_MAX_LENGTH,
	REQUEST_KINDS,
	REQUEST_SWEEP_INTERVAL_MS,
	TEXT_ANSWER_MAX_LENGTH,
	answerRequest,
	awaitRequest,
	cancelRequest,
	countPendingRequests,
	createRequest,
	expireRequests,
	findRequest,
	listPendingRequests,
	requestInput,
	startRequestSweeper,
	validateAnswer,
	type CreateRequestInput,
	type OwnerRequest,
	type RequestAnswer,
	type RequestConfig,
	type RequestKind,
	type RequestResult,
	type RequestState,
	type RequestSweeperOptions,
	type RequestValue,
	type RequestWaitOptions
} from './requests';
export {
	OPEN_TASK_STATES,
	TASK_BODY_MAX_LENGTH,
	TASK_DEFAULT_LIMIT,
	TASK_MAX_LIMIT,
	TASK_RESULT_MAX_LENGTH,
	TASK_TITLE_MAX_LENGTH,
	assignTask,
	broadcastTask,
	cancelTask,
	claimTask,
	completeTask,
	countOpenTasks,
	findTask,
	createTask,
	listTasks,
	type ClaimTaskInput,
	type CompleteTaskInput,
	type CompletedTask,
	type CreateTaskInput,
	type ListTasksInput
} from './tasks';
/**
 * Web Push (design §5, §7): the one channel that reaches an owner whose
 * dashboard is closed. Off unless a VAPID keypair is configured.
 */
export {
	DEFAULT_PUSH_TYPES,
	MAX_PUSH_ACTIONS,
	MAX_PUSH_FAILURES,
	PUSH_TYPES,
	assertPushPrefs,
	notifies,
	repliesToOwner,
	replyMessage,
	setDevicePrefs,
	updateMessage,
	PUSH_LABEL_MAX_LENGTH,
	PUSH_TTL_S,
	listPushSubscriptionsFor,
	requestMessage,
	sendPush,
	startRequestPusher,
	subscribeToPush,
	unsubscribeFromPush
} from './push';
export type {
	Notifiable,
	PushAction,
	PushMessage,
	PushType,
	PushResult,
	PushSettings,
	PushSubscriptionInput,
	RequestPusherOptions,
	SendPushOptions
} from './push';
/**
 * Public share links (design §7, §8): the one unauthenticated read in the
 * product, scoped to a single card and revocable.
 */
export {
	SHARE_PATH_PREFIX,
	SHARE_TOKEN_BYTES,
	findUpdateShare,
	listUpdateShares,
	hashShareToken,
	readShare,
	revokeUpdateShare,
	shareGrantsMedia,
	shareUpdate,
	shareUrl
} from './shares';
export type {
	MintedShare,
	ReadShareInput,
	ShareMediaInput,
	SharedCard,
	ShareUpdateInput
} from './shares';
