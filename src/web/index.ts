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
	type NewProject,
	type OwnerActions,
	type ProjectPatch,
	type Requester
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
export { dayKey, dayLabel, groupByDay, timeLabel, type DayGroup, type Dated } from './days';
export type {
	MediaKind,
	MediaStatus,
	MediaVariant,
	MediaView,
	ProjectStatus,
	ProjectView,
	SnapshotResponse,
	UpdateLevel,
	UpdateView,
	UpdatesPage
} from './types';
export { PRESENCE_WINDOW_MS, Presence, heartbeatLabel } from './presence.svelte';
export type {
	AgentsSnapshot,
	LiveAgentView,
	PresenceOptions,
	PresenceStatus
} from './presence.svelte';
