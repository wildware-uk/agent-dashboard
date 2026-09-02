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
 * Derivatives are the second half (design §11 step 10, §6 steps 4-5):
 *
 * ```ts
 * import { processPendingMedia, startDerivativeWorker } from '$media';
 *
 * startDerivativeWorker();                             // for the life of the process
 * await processPendingMedia(settings, { db });         // or drain the backlog now
 * ```
 *
 * The work is driven off the `media` table rather than off the upload, so media
 * that landed before this code existed is derived too, and a restart
 * mid-transcode resumes rather than losing the item.
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
	createOwnerMedia,
	createUpload,
	type CreateUploadInput,
	type CreatedUpload,
	type OwnerMediaInput
} from './upload';
export {
	ingest,
	storeBytes,
	type IngestInput,
	type IngestResult,
	type StoreBytesInput
} from './ingest';
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
export {
	POSTER_QUALITY,
	REASON_MAX,
	THUMB_QUALITY,
	THUMB_WIDTHS,
	processMedia,
	readMediaFailure,
	type DeriveOptions,
	type DeriveOutcome
} from './derive';
export {
	FFMPEG,
	FFMPEG_TIMEOUT_MS,
	FFPROBE,
	POSTER_AT_S,
	isWebPlayable,
	posterSeconds,
	probeVideo,
	type VideoProbe
} from './ffmpeg';
export { DEFAULT_CONCURRENCY, type JobOutcome } from './queue';
export {
	DERIVATIVE_BATCH,
	DerivativePipeline,
	WORKER_INTERVAL_MS,
	processPendingMedia,
	startDerivativeWorker,
	type PendingInput,
	type PendingResult,
	type PipelineOptions,
	type WorkerOptions
} from './pipeline';
