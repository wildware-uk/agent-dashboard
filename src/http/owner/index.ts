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
 * | `DELETE /api/updates/[id]`       | Soft delete one update.                     |
 *
 * All four require the owner's session and answer `401 {"error":"unauthenticated"}`
 * without it. Every success publishes exactly one event, so a second open tab
 * follows along over `GET /api/stream` without polling.
 */
export {
	createProjectHandler,
	deleteUpdateHandler,
	patchProjectHandler,
	patchUpdateHandler,
	readCreateProject,
	readProjectPatch,
	readUpdatePatch
} from './actions';
export type { OwnerActionEvent, OwnerHandler, OwnerHandlerOptions } from './actions';
