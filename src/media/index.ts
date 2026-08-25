/**
 * Public entry point for the media pipeline (design §6, §11 step 9).
 *
 * ```ts
 * import { createUpload, ingest, openVariant, sweepOrphanedMedia, mediaSettings } from '$media';
 *
 * const settings = mediaSettings();
 * const created = createUpload(settings, { db, agentId, filename, mime, bytes });
 * // ... the agent PUTs to created.uploadUrl ...
 * const { media } = await ingest(settings, { db, token, body: request.body });
 * const file = await openVariant(settings, { db, id: media.id, variant: 'original' });
 * ```
 *
 * Four functions and a settings reader. What is deliberately *not* here is
 * anything that builds a path: `./paths.ts` is internal, callers get metadata
 * and an `open()` (design §2 — "callers never learn paths"), and the temp
 * directory an upload streams through is outside the served tree entirely.
 *
 * Derivatives — thumbnails, poster frames, transcodes — are the next slice
 * (design §11 step 10). This one leaves an uploaded row `pending` with its real
 * size and hash, publishes nothing, and serves `original`; `openVariant` already
 * serves the other variants the moment rows exist for them.
 *
 * `./testing.ts` is a second, test-only entry point and is not re-exported here.
 */
export {
	MediaError,
	isMediaError,
	mediaConflict,
	mediaInvalid,
	mediaNotFound,
	tokenRejected,
	tooLarge,
	unsupportedType,
	type MediaErrorCode
} from './errors';
export { mediaSettings, type MediaSettings } from './settings';
export {
	ALLOWED_MIMES,
	IMAGE_MIMES,
	SNIFF_BYTES,
	VIDEO_MIMES,
	extensionForMime,
	isAllowedMime,
	kindForMime,
	normaliseMime,
	type AllowedMime
} from './mime';
export { UPLOAD_ROUTE, UPLOAD_TOKEN_TTL_MS, uploadPath, uploadUrl } from './tokens';
export {
	FILENAME_MAX_LENGTH,
	createUpload,
	type CreateUploadInput,
	type CreatedUpload
} from './upload';
export { ingest, type IngestInput, type IngestResult } from './ingest';
export {
	VARIANTS,
	derivativesFor,
	isVariant,
	openVariant,
	type AvailableVariant,
	type MediaFile,
	type Variant
} from './serve';
export {
	ORPHAN_AGE_MS,
	SWEEP_BATCH,
	SWEPT_STATUSES,
	sweepOrphanedMedia,
	type SweepInput,
	type SweepResult
} from './sweeper';
