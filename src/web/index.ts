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
export { agentLabel, avatarFor, type Avatar } from './avatar';
export { LEVELS, levelStyle, type LevelStyle } from './levels';
export { dayKey, dayLabel, groupByDay, timeLabel, type DayGroup, type Dated } from './days';
export type {
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
