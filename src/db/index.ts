/**
 * Public entry point for the persistence module (design §2, §3).
 *
 * Other modules import from `$db`, never from a file inside it, so the
 * repository layout can change without touching callers. The one exception is
 * `$db/testing`, which is a second, test-only entry point — keeping it separate
 * means nothing in a production path can reach for an in-memory database.
 *
 * Everything here is plain SQL over plain objects. Business rules belong in
 * `src/domain/`; see ./README.md for the boundary this module keeps.
 */

// Connection and schema lifecycle.
export {
	closeDatabase,
	databaseFile,
	getDatabase,
	openDatabase,
	DATABASE_FILE,
	MEMORY,
	type Db,
	type OpenOptions
} from './connection';
export {
	appliedMigrations,
	migrate,
	pendingMigrations,
	type AppliedMigration,
	type Migration
} from './migrate';
export { MIGRATIONS } from './migrations';
export { MIGRATIONS_TABLE, TABLES, type TableName } from './schema';

// Identifiers.
export { isId, newId, ID_LENGTH } from './ids';

// Row shapes.
export type {
	AckState,
	Acknowledgement,
	Agent,
	Approval,
	ApprovalState,
	Derivative,
	DerivativeKind,
	Keyed,
	Media,
	MediaKind,
	MediaStatus,
	Message,
	MessageDelivery,
	Notification,
	NotificationKind,
	Embed,
	EmbedType,
	Reaction,
	Project,
	BoardColumn,
	ProjectBoard,
	ProjectStatus,
	ProjectTheme,
	ReadCursor,
	RequestAnswer,
	RequestConfig,
	RequestKind,
	RequestValue,
	Session,
	SessionMeta,
	App,
	AppView,
	CardField,
	CardTag,
	Tag,
	Task,
	TaskState,
	Update,
	UpdateLevel,
	UpdatePriority,
	UploadToken
} from './types';

// Repositories, one module per entity.
export {
	findProjectById,
	findProjectBySlug,
	insertProject,
	listProjects,
	updateProject,
	type NewProject,
	type ProjectPatch
} from './projects';
export {
	findAgentById,
	findAgentByTokenHash,
	insertAgent,
	listAgents,
	renameAgent as renameAgentRow,
	revokeAgent,
	touchAgent,
	type NewAgent
} from './agents';
export {
	endSession,
	endStaleSessions,
	findSessionById,
	heartbeatSession,
	insertSession,
	listLiveSessions,
	listSessionsForAgent,
	type NewSession
} from './sessions';
export {
	findUpdateById,
	insertUpdate,
	listUpdates,
	editUpdate as editUpdateRow,
	setUpdatePinned,
	softDeleteUpdate,
	type NewUpdate,
	type UpdateQuery
} from './updates';
export {
	attachMediaToMessage,
	attachMediaToRequest,
	attachMediaToUpdate,
	deleteMedia,
	findMediaById,
	findMediaBySha256,
	insertMedia,
	listMediaByStatus,
	listMediaForMessage,
	listMediaForRequest,
	listMediaForUpdate,
	listOrphanedMedia,
	setMediaBytes,
	setMediaStatus,
	type MediaResult,
	type NewMedia
} from './media';
export {
	deleteDerivatives,
	findDerivative,
	insertDerivative,
	listDerivatives,
	upsertDerivative,
	type NewDerivative
} from './derivatives';
export {
	consumeUploadToken,
	deleteExpiredUploadTokens,
	findUploadTokenById,
	insertUploadToken,
	releaseUploadToken,
	type NewUploadToken
} from './upload-tokens';
export {
	deleteCardField,
	findCardField,
	listCardFields,
	upsertCardField,
	type NewCardField
} from './fields';
export {
	findAppById,
	findAppByUri,
	findAppView,
	insertAppView,
	listAppViews,
	listApps,
	updateAppViewData,
	updateAppViewState,
	upsertApp,
	type NewApp,
	type NewAppView
} from './apps';
export {
	addCardTag,
	deleteTag,
	findCardTag,
	findTagById,
	findTagBySlug,
	insertTag,
	listCardTags,
	listTags,
	removeCardTag,
	updateTag,
	type NewTag
} from './tags';
export {
	CARD_ANCHOR,
	CARD_ANCHORS,
	CARD_KINDS,
	CARD_STATUSES,
	CARD_TABLE,
	OPEN_STATUSES,
	countOpenWork,
	countWorkByStatus,
	findCard,
	isCardKind,
	isCardStatus,
	listWork,
	setCardPinned,
	setCardStatus,
	type CardKind,
	type CardRef,
	type CardRow,
	type CardStatus,
	type WorkQuery,
	type WorkRow
} from './cards';
export {
	countMessagesAfter,
	countUnreadMessages as countUnreadMessageRows,
	listAgentProjectIds,
	editMessage as editMessageRow,
	findMessageById,
	insertMessage,
	listMessages,
	listRepliesTo,
	listUnreadMessages,
	softDeleteMessage,
	type MessageQuery,
	type NewMessage,
	type UnreadQuery
} from './messages';
export {
	advanceReadCursor,
	getReadCursor,
	listReadCursors,
	readCursorSeq,
	NO_PROJECT
} from './read-cursors';
export { deliveredMessageIds, listDeliveries, recordDelivery } from './deliveries';
export { listMessageMentions, setMessageMentions } from './mentions';
export { addReaction, listReactions, removeReaction } from './reactions';
export {
	findEmbedTypeById,
	findEmbedTypeBySlug,
	insertEmbed,
	listEmbedTypes,
	listEmbedsForMessage,
	listEmbedsForRequest,
	listEmbedsForTask,
	listEmbedsForUpdate,
	upsertEmbedType,
	type NewEmbed,
	type NewEmbedType
} from './embeds';
export {
	countUnseenNotifications,
	insertNotification,
	listNotifications,
	markNotificationsSeen,
	type NewNotification,
	type NotificationQuery
} from './notifications';
export {
	listAcknowledgements,
	upsertAcknowledgement,
	type AcknowledgementQuery,
	type NewAcknowledgement
} from './acknowledgements';
export {
	countPendingApprovals,
	decideApproval,
	editApproval as editApprovalRow,
	expireApprovals,
	findApprovalById,
	insertApproval,
	listApprovals,
	type ApprovalDecision,
	type ApprovalQuery,
	type NewApproval
} from './approvals';
export {
	countPushSubscriptions,
	deletePushSubscription,
	findPushSubscription,
	listPushSubscriptions,
	markPushFailed,
	markPushSent,
	setPushPrefs,
	upsertPushSubscription,
	type NewPushSubscription,
	type PushPrefs,
	type PushSubscription
} from './push';
export {
	clearOwnerDeviceToken,
	deleteOwnerDevice,
	findOwnerDeviceById,
	findOwnerDeviceByTokenHash,
	insertOwnerDevice,
	listOwnerDevices,
	markOwnerDevicePushed,
	markOwnerDevicePushFailed,
	setOwnerDeviceAlertProjects,
	setOwnerDeviceApns,
	setOwnerDeviceLiveActivity,
	touchOwnerDevice,
	type ApnsEnvironment,
	type LiveActivityTokens,
	type NewOwnerDevice,
	type OwnerDevice,
	type OwnerDeviceTokenColumn
} from './owner-devices';
export {
	findLiveShareForUpdate,
	findShareById,
	findShareByTokenHash,
	insertUpdateShare,
	listSharesForUpdate,
	recordShareView,
	revokeSharesForUpdate,
	type NewUpdateShare,
	type UpdateShare
} from './shares';
