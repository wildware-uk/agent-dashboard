/**
 * Public entry point for the media routes (design §6, §11 step 9).
 *
 * `src/http/routes/api/upload/[token]/+server.ts` and
 * `src/http/routes/media/[id]/[variant]/+server.ts` are thin mounts over these,
 * so the interesting behaviour — the status a refusal becomes, the cache and
 * hardening headers, the per-token limit — is tested without a server.
 *
 * ```ts
 * import { createUploadHandler, createMediaHandler } from '$http/media';
 * ```
 */
export {
	UPLOAD_RATE_LIMIT,
	UPLOAD_RATE_WINDOW_MS,
	createUploadHandler,
	type UploadHandler,
	type UploadHandlerOptions,
	type UploadRequestEvent
} from './upload';
export {
	IMMUTABLE_CACHE_CONTROL,
	createMediaHandler,
	type MediaHandler,
	type MediaHandlerOptions,
	type MediaRequestEvent
} from './serve';
export { mediaConfig } from './env';
