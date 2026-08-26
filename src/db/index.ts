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
	Project,
	ProjectStatus,
	ReadCursor,
	RequestAnswer,
	RequestConfig,
	RequestKind,
	RequestValue,
	Session,
	SessionMeta,
	Task,
	TaskState,
	Update,
	UpdateLevel,
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
	setUpdatePinned,
	softDeleteUpdate,
	type NewUpdate,
	type UpdateQuery
} from './updates';
export {
	attachMediaToUpdate,
	deleteMedia,
	findMediaById,
	findMediaBySha256,
	insertMedia,
	listMediaByStatus,
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
	type NewUploadToken
} from './upload-tokens';
export {
	assignTask,
	cancelTask,
	claimTask,
	completeTask,
	findTaskById,
	insertTask,
	listTasks,
	type NewTask,
	type TaskQuery
} from './tasks';
export {
	countMessagesAfter,
	findMessageById,
	insertMessage,
	listMessages,
	type MessageQuery,
	type NewMessage
} from './messages';
export { advanceReadCursor, getReadCursor, readCursorSeq } from './read-cursors';
export {
	countPendingApprovals,
	decideApproval,
	expireApprovals,
	findApprovalById,
	insertApproval,
	listApprovals,
	type ApprovalDecision,
	type ApprovalQuery,
	type NewApproval
} from './approvals';
