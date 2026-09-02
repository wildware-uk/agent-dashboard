/**
 * Public entry point for shared browser code.
 *
 * Reachable as both `$web` and `$lib`. Components live alongside as `.svelte`
 * files and are imported directly (`$web/Shell.svelte`); this file re-exports
 * the client store and the pure helpers the components share, so a route or a
 * later slice imports one name from one place.
 *
 * Everything here runs in the browser. Its only data source is the HTTP API —
 * `GET /api/stream` and the snapshot endpoints (design §2, §4).
 */
export { Timeline } from './timeline.svelte';
export type { Fetcher, StreamLike, TimelineOptions, TimelineStatus } from './timeline.svelte';
/**
 * The tab's one connection to `GET /api/stream` (#19).
 *
 * Anything live on the page subscribes to this rather than opening a connection
 * of its own: browsers allow six per origin on HTTP/1.1, and an SSE connection
 * holds one for as long as the page is open.
 */
export {
	EVENT_TYPES,
	SharedStream,
	sharedStream,
	browserLink,
	DirectLink,
	LeaderLink
} from './stream';
export type {
	EventType,
	Link,
	OpenStream,
	StreamConsumer,
	StreamFrame,
	StreamMessage,
	Subscription
} from './stream';
export {
	ActionError,
	actionMessage,
	ownerActions,
	type NewMessage,
	type NewProject,
	type NewTask,
	type OwnerActions,
	type ProjectPatch,
	type Requester,
	type TaskPatch
} from './actions';
export { renderMarkdown } from './markdown';
export {
	CELL_RATIO,
	DEFAULT_RATIO,
	MAX_RATIO,
	MIN_RATIO,
	durationLabel,
	gridColumns,
	intrinsic,
	isViewable,
	mediaLabel,
	mediaUrl,
	posterSrc,
	thumbSrc,
	thumbSrcset,
	tileRatio,
	videoSrc
} from './media';
export { agentLabel, avatarFor, type Avatar } from './avatar';
export { LEVELS, levelStyle, type LevelStyle } from './levels';
export {
	absoluteLabel,
	dayKey,
	dayLabel,
	groupByDay,
	relativeLabel,
	timeLabel,
	type DayGroup,
	type Dated
} from './days';
/** One ticking clock for every relative timestamp on the page (design §7). */
export { Clock, TICK_MS, clock, type ClockOptions } from './clock.svelte';
export type {
	MediaKind,
	MediaStatus,
	MediaVariant,
	MediaView,
	ProjectStatus,
	ProjectView,
	MessageView,
	MessagesSnapshot,
	RequestAnswer,
	RequestConfig,
	RequestKind,
	RequestState,
	RequestView,
	RequestsSnapshot,
	SnapshotResponse,
	TaskState,
	TaskView,
	TasksSnapshot,
	UpdateLevel,
	UpdateView,
	UpdatesPage
} from './types';
/**
 * The page's message threads (design §7). One store per page, read by every
 * card, so a fifty-card timeline costs one request rather than fifty.
 */
export { Threads } from './threads.svelte';
export type { ThreadSource, ThreadsOptions, ThreadsStatus } from './threads.svelte';
/**
 * The owner's task list (design §5, §7). One store per page, rendered in the
 * rail on a desktop and in the rail drawer on a phone.
 */
export { Tasks } from './tasks.svelte';
export type { TasksOptions, TasksStatus } from './tasks.svelte';
/**
 * What agents are waiting on the owner for (design §5, §7). One store per page,
 * read by two regions: the cards at the top of the feed, and the sidebar's
 * per-project count.
 */
export { Requests, browserNotifier } from './requests.svelte';
export type { Notifier, RequestsOptions, RequestsStatus } from './requests.svelte';
export { PRESENCE_WINDOW_MS, Presence, heartbeatLabel } from './presence.svelte';
export type {
	AgentsSnapshot,
	LiveAgentView,
	PresenceOptions,
	PresenceStatus
} from './presence.svelte';
/**
 * Web Push in the browser (design §7): whether *this* browser will be told that
 * an agent is waiting, derived from the deployment, the OS grant and the
 * subscription rather than remembered.
 */
export { Push, decodeKey } from './push.svelte';
export type { PushOptions, PushPermission, PushStatus } from './push.svelte';
