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
	Reaction,
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
	resolveProject,
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
	EMBEDS_PER_POST_MAX,
	EMBED_AVATAR_SHAPES,
	EMBED_BLOCK_TYPES,
	EMBED_CHIP_STYLES,
	EMBED_FIELD_LAYOUTS,
	EMBED_HEADER_LAYOUTS,
	EMBED_MARKS,
	EMBED_PADDINGS,
	EMBED_SIZES,
	EMBED_TONES,
	EMBED_DATA_KEYS_MAX,
	EMBED_FIELDS_MAX,
	EMBED_FONTS,
	EMBED_BLOCKS_MAX,
	EMBED_NAME_MAX_LENGTH,
	EMBED_RADII,
	EMBED_SLUG,
	EMBED_SLUG_MAX_LENGTH,
	EMBED_VALUE_MAX_LENGTH,
	attachEmbeds,
	checkedEmbeds,
	isMediaReference,
	listEmbedTypeViews,
	listMessageEmbeds,
	listRequestEmbeds,
	listUpdateEmbeds,
	parseEmbedData,
	parseEmbedSpec,
	registerEmbedType,
	type EmbedAvatarShape,
	type EmbedBlock,
	type EmbedBlockType,
	type EmbedChipStyle,
	type EmbedChrome,
	type EmbedFieldLayout,
	type EmbedFrame,
	type EmbedHeaderLayout,
	type EmbedMark,
	type EmbedPadding,
	type EmbedSize,
	type EmbedTone,
	type EmbedData,
	type EmbedSpec,
	type EmbedTheme,
	type EmbedTypeView,
	type EmbedView,
	type NewEmbedInput,
	type RegisterEmbedTypeInput
} from './embeds';
export {
	ALLOWED_MIMES,
	DOWNLOAD_MIME,
	assertAttachableToMessage,
	listMessageMedia,
	listRequestMedia,
	mediaSettings,
	mediaIsAttached,
	readAttachmentBytes,
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
	type AttachmentBytes,
	type AttachMediaInput,
	type AttachMediaResult,
	type CreateUploadInput,
	type IngestUploadInput,
	type IngestedMedia,
	type MediaAttachment,
	type MediaSettings,
	type MediaSweeperOptions,
	type UploadGrant
} from './media';
export {
	BODY_MAX_LENGTH,
	DEFAULT_LIMIT,
	MAX_LIMIT,
	TITLE_MAX_LENGTH,
	deleteUpdate,
	findUpdate,
	listUpdates,
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
	authorName,
	authorText,
	countUnreadMessages,
	alreadyDelivered,
	countUnreadMessagesInScope,
	deleteMessage,
	deliveriesFor,
	editMessage,
	type EditMessageInput,
	findMessage,
	answeredMessage,
	type AnsweredMessage,
	QUOTED_MAX_LENGTH,
	markMessagesDelivered,
	projectsForAgent,
	unreadMessagesInScope,
	listThread,
	threadOf,
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
export { EMOJI_MAX_LENGTH, SHORTCODES, assertEmoji } from './reactions';
export {
	FIELDS_PER_CARD,
	FIELD_NAME_MAX,
	FIELD_VALUE_MAX,
	fieldSlug,
	fieldsForCards,
	fieldsOn,
	setField,
	type CardField,
	type FieldScope,
	type SetFieldInput,
	type SetFieldResult
} from './fields';
export {
	APPS_PER_POST_MAX,
	APP_CSP_ORIGINS_MAX,
	APP_DATA_MAX_LENGTH,
	APP_DESCRIPTION_MAX_LENGTH,
	APP_HTML_MAX_LENGTH,
	APP_MIME,
	APP_NAME_MAX_LENGTH,
	APP_STATE_MAX_LENGTH,
	APP_TITLE_MAX_LENGTH,
	APP_URI_MAX_LENGTH,
	APP_URI_SCHEME,
	APP_URL_MAX_LENGTH,
	appDocument,
	appViewById,
	appsForCards,
	appsOn,
	attachApps,
	checkedApps,
	listAppSummaries,
	parseAppCsp,
	parseAppPage,
	parseAppUri,
	registerApp,
	saveAppState,
	setAppData,
	type AppCsp,
	type AppScope,
	type AppSummary,
	type AppViewData,
	type CheckedApp,
	type NewAppInput,
	type RegisterAppInput,
	type SetAppDataInput
} from './apps';
export {
	TAGS_PER_CARD,
	TAGS_PER_PROJECT,
	TAG_COLOURS,
	TAG_MAX_LENGTH,
	defineTag,
	isTagColour,
	listTags,
	renameTag,
	retireTag,
	tagCard,
	tagSlug,
	tagsForCards,
	type DefineTagInput,
	type CardTag,
	type Tag,
	type TagCardInput,
	type TagCardResult,
	type TagColour,
	type TagScope
} from './tags';
export {
	CARD_KINDS,
	CARD_STATUSES,
	WORK_SUMMARY_CHARS,
	announceCard,
	countOpenWorkInScope,
	isCardKind,
	isCardStatus,
	listWorkInScope,
	oneCard,
	pinCard,
	setStatus,
	reactToCard as react,
	reactionsForCards as reactionsFor,
	resolveCard,
	type CardKind,
	type CardRef,
	type CardStatus,
	type ReactToCardInput as ReactInput,
	type ReactResult,
	type WorkItem,
	type WorkScope
} from './cards';
export {
	DEFAULT_NOTIFICATION_LIMIT,
	countUnseen,
	listNotifications,
	markSeen,
	notificationForMessage,
	notificationForRequest,
	notificationForUpdate,
	recordNotification,
	startNotificationRecorder,
	type NotificationView
} from './notifications';
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
	withdrawRequest,
	countPendingRequests,
	countPendingRequestsInScope,
	createRequest,
	editRequest,
	type EditRequestInput,
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
/*
 * The task lifecycle is gone (migration 035).
 *
 * The owner: "remove tasks and the board." Work is a state a card is in now —
 * `setStatus` in `./cards.ts` — so there is nothing here to create, claim,
 * complete or cancel. `$db`'s task rows survive as the history the conversion
 * came from, and nothing in the product reads them.
 */
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
/** The owner's phones: a per-install owner key and its Apple push tokens. */
export {
	ALERT_PROJECTS_MAX,
	APNS_ENVIRONMENTS,
	DEVICE_NAME_MAX_LENGTH,
	DEVICE_SEEN_RESOLUTION_MS,
	authenticateOwnerDevice,
	deviceAlertProjects,
	deviceWantsAlert,
	findOwnerDevice,
	forgetDeviceToken,
	listOwnerDevices,
	deviceName,
	mintOwnerDevice,
	revokeOwnerDevice,
	setDeviceAlertPrefs,
	setDeviceAlertProjects,
	setDeviceApnsToken,
	setDeviceLiveActivityTokens
} from './devices';
export type { ApnsEnvironment, MintedDevice, OwnerDevice } from './devices';
/** One small read of the whole dashboard, for widgets and the Live Activity. */
export { liveActivityState, ownerSummary } from './summary';
export type { LiveActivityState, OwnerSummary, SummaryRequest } from './summary';
/** Apple push for the iOS app: alerts, and the Live Activity. */
export {
	alertHeaders,
	alertPayload,
	apnsAlertFor,
	createApnsTransport,
	createProviderTokenSigner,
	deliverToDevice,
	sendApnsAlert,
	startApnsPusher,
	truncateBytes
} from './apns';
export type {
	AlertSource,
	ApnsAlert,
	ApnsPusherOptions,
	ApnsRequest,
	ApnsResponse,
	ApnsSettings,
	ApnsTransport
} from './apns';
export {
	LIVE_ACTIVITY_ATTRIBUTES_TYPE,
	createLiveActivityPusher,
	liveActivityHeaders,
	startLiveActivityPusher
} from './live-activity';
export type { LiveActivityPusher, LiveActivityPusherOptions } from './live-activity';
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
