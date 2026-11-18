/**
 * Public entry point for the owner's write endpoints (design §7, §11 step 16).
 *
 * The route files under `src/http/routes/api/` are thin mounts over these, so
 * the whole owner surface — auth, validation, error mapping, and the event each
 * write publishes — is tested without a server.
 *
 * ```ts
 * import { createProjectHandler } from '$http/owner';
 * export const POST = createProjectHandler();
 * ```
 *
 * | Route                            | Does                                        |
 * | -------------------------------- | ------------------------------------------- |
 * | `POST /api/projects`             | Create a project. Idempotent on slug.       |
 * | `PATCH /api/projects/[reference]`| Rename, re-describe, pin, archive.          |
 * | `PATCH /api/updates/[id]`        | Pin or unpin one update.                    |
 * | `POST /api/cards/[kind]/[id]/pin`| Pin or unpin any card (migration 034).      |
 * | `POST /api/cards/[kind]/[id]/status` | Mark a card as work, or move it (035).  |
 * | `POST /api/cards/[kind]/[id]/reactions` | React to any card.                   |
 * | `POST /api/apps/[view]/state`    | Keep what an app saved for itself (041).    |
 * | `DELETE /api/updates/[id]`       | Soft delete one update.                     |
 * | `GET /api/messages`              | One thread, or every thread in a project.   |
 * | `POST /api/messages`             | Reply as the owner: the literal `human`.    |
 * | `POST /api/requests/[id]/answer` | Answer an agent's request. Checked in `$domain`. |
 * | `DELETE /api/requests/[id]`      | Dismiss it: the agent is told `cancelled`.  |
 * | `POST /api/updates/[id]/share`   | Publish one card. Returns the link, once.   |
 * | `DELETE /api/updates/[id]/share` | Stop the link working.                      |
 * | `GET /api/push`                  | Whether push is on, and the VAPID public key. |
 * | `POST /api/push`                 | Store this browser's push subscription.     |
 * | `PATCH /api/push`                | What one device is notified about.          |
 * | `DELETE /api/push`               | Forget it again. Idempotent.                |
 * | `POST/GET /api/devices`          | Mint or list the owner's phones' keys.      |
 * | `DELETE /api/devices/[id]`       | Revoke one phone's key.                     |
 * | `PUT /api/devices/current/apns`  | The calling phone's alert token.            |
 * | `PUT /api/devices/current/live-activity` | Its Live Activity tokens.           |
 * | `GET /api/summary`               | The dashboard in one read, for widgets.     |
 *
 * All of them require the owner's session and answer `401 {"error":"unauthenticated"}`
 * without it. Every success publishes exactly one event, so a second open tab
 * follows along over `GET /api/stream` without polling.
 */
export {
	createProjectHandler,
	deleteUpdateHandler,
	patchProjectHandler,
	patchUpdateHandler,
	readAgentPatch,
	renameAgentHandler,
	readCreateProject,
	readProjectPatch,
	readUpdatePatch
} from './actions';
export type { OwnerActionEvent, OwnerHandler, OwnerHandlerOptions } from './actions';
export {
	pinCardHandler,
	reactToCardHandler,
	setCardFieldHandler,
	setCardStatusHandler,
	tagCardHandler
} from './cards';
export { defineTagHandler, listTagsHandler, renameTagHandler, retireTagHandler } from './tags';
export { saveAppStateHandler } from './apps';
export { FILENAME_PARAM, uploadMediaHandler } from './media';
export { answerRequestHandler, dismissRequestHandler } from './requests';
export {
	createDeviceHandler,
	signInDeviceHandler,
	deleteDeviceHandler,
	listDevicesHandler,
	setAlertPrefsHandler,
	setAlertProjectsHandler,
	setApnsTokenHandler,
	setLiveActivityHandler,
	summaryHandler
} from './devices';
export type { DeviceHandlerOptions } from './devices';
export {
	revokeShareHandler,
	shareUpdateHandler,
	type ShareHandlerOptions,
	type ShareSettings
} from './shares';
export {
	pushPrefsHandler,
	pushStatusHandler,
	subscribePushHandler,
	unsubscribePushHandler,
	type PushHandlerOptions,
	type PushSettings
} from './push';
export {
	MAX_NOTIFICATIONS,
	listNotificationsHandler,
	markNotificationsSeenHandler,
	type NotificationHandlerOptions
} from './notifications';
export {
	deleteMessageHandler,
	listMessagesHandler,
	postMessageHandler,
	reactHandler,
	readReply,
	readThreadQuery,
	type MessageHandlerOptions
} from './messages';
