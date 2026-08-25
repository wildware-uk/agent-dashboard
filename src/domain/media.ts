/**
 * Media, as a business rule (design §6).
 *
 * The pipeline itself lives in `$media`; this is the door every adapter comes
 * through, so that an upload started by an MCP tool and one started by the
 * browser cannot diverge. What the domain adds on top of `$media` is the part
 * that is about *this application* rather than about bytes:
 *
 * - **Identity.** `agentId` always comes from a resolved bearer token, and
 *   attaching is scoped to the calling agent in the same statement that does it,
 *   so one agent can never decorate its update with another's screenshots.
 * - **Vocabulary.** `$media` has codes of its own (`too_large`,
 *   `unsupported_type`, `token_rejected`) because 400 is the wrong answer to a
 *   200MB video. The two tool-facing functions here translate those into the
 *   domain's three codes; `ingestUpload` deliberately does not, and lets the
 *   `MediaError` through so `PUT /api/upload/:token` can answer 413 or 415. That
 *   is documented on the function.
 *
 * **Nothing here publishes an event.** A reservation is not news, and an
 * attachment is announced by `media.ready` when the derivative pipeline finishes
 * (design §6 step 5, §11 step 10) — which is the event the browser is waiting
 * for anyway, because a placeholder cannot be swapped for bytes that have not
 * been processed. `post_update` still publishes exactly one `update.created`,
 * and it does so *after* attaching, so a browser that fetches the update on
 * hearing about it sees the whole card.
 */
import { attachMediaToUpdate, findMediaById, findUpdateById, isId } from '$db';
import {
	createUpload as mintUpload,
	ingest,
	isMediaError,
	mediaSettings,
	openVariant,
	sweepOrphanedMedia,
	type CreatedUpload,
	type MediaFile,
	type MediaSettings,
	type SweepResult,
	type Variant
} from '$media';
import { context, type DomainContext } from './context';
import { conflict, invalid, notFound, type DomainError } from './errors';

/**
 * Re-exported so `$mcp` can name the allowlist and the filename limit in a tool
 * description without importing `$media`, which the module table forbids
 * (design §2). The values still have exactly one definition.
 */
export { ALLOWED_MIMES, FILENAME_MAX_LENGTH, UPLOAD_TOKEN_TTL_MS } from '$media';

/**
 * Most media one update may carry.
 *
 * A generous grid, and a bound: `media_ids` arrives from a language model, and
 * an unbounded list of ids is an unbounded `IN (...)`.
 */
export const MEDIA_PER_UPDATE_MAX = 24;

/** Turn a media refusal into one the rest of the domain speaks. */
function asDomainError(error: unknown): DomainError | undefined {
	if (!isMediaError(error)) return undefined;
	switch (error.code) {
		case 'not_found':
			return notFound(error.message);
		case 'conflict':
			return conflict(error.message);
		// A cap and an allowlist are both things the caller can correct by asking
		// again differently, which is what `invalid_argument` means to an agent.
		default:
			return invalid(error.message);
	}
}

/** Run a `$media` call, reporting its refusals in the domain's vocabulary. */
function translating<T>(body: () => T): T {
	try {
		return body();
	} catch (error) {
		const translated = asDomainError(error);
		if (translated) throw translated;
		throw error;
	}
}

export type CreateUploadInput = {
	/** The uploading agent, resolved from its bearer token. */
	agentId: string;
	/** What the agent calls the file. A label: it is stored nowhere. */
	filename: string;
	/** The type the agent claims. Verified against the bytes at ingest. */
	mime: string;
	/** Exact byte length. Becomes the cap the PUT is cut off at. */
	bytes: number;
};

/** Everything `create_upload` answers with. */
export type UploadGrant = CreatedUpload;

/**
 * Reserve a media id and mint the single-use URL its bytes go to.
 *
 * @throws {@link DomainError} `invalid_argument` for a type off the allowlist
 *   (SVG always), a size that is not a positive integer, or one past the
 *   configured cap; `not_found` for an unknown agent.
 */
export function createUpload(
	ctx: DomainContext,
	input: CreateUploadInput,
	settings: MediaSettings = mediaSettings()
): UploadGrant {
	return translating(() =>
		mintUpload(settings, {
			db: ctx.db,
			agentId: input.agentId,
			filename: input.filename,
			mime: input.mime,
			bytes: input.bytes,
			now: ctx.now()
		})
	);
}

export type IngestUploadInput = {
	/** The signed token from the URL. */
	token: string;
	body: ReadableStream<Uint8Array> | null;
	/** `Content-Length`, if the client sent one. Never trusted for the cap. */
	contentLength?: number | null;
};

/** What the upload route reports back to the agent that PUT the bytes. */
export type IngestedMedia = {
	mediaId: string;
	kind: string;
	mime: string;
	bytes: number;
	sha256: string;
	status: string;
	/** Whether these exact bytes were already stored under another media id. */
	deduped: boolean;
};

/**
 * Take one upload.
 *
 * @throws {@link MediaError} — **not** a `DomainError`. The upload route needs to
 *   answer 403 for a spent token, 413 for an oversized body and 415 for bytes
 *   that are not what they claimed, and collapsing those into
 *   `invalid_argument` would leave an agent retrying blind. `$http/media` maps
 *   the codes; every other caller of the domain still sees `DomainError`s only.
 */
export async function ingestUpload(
	ctx: DomainContext,
	input: IngestUploadInput,
	settings: MediaSettings = mediaSettings()
): Promise<IngestedMedia> {
	const { media, deduped } = await ingest(settings, {
		db: ctx.db,
		token: input.token,
		body: input.body,
		contentLength: input.contentLength,
		now: ctx.now()
	});

	return {
		mediaId: media.id,
		kind: media.kind,
		mime: media.mime,
		bytes: media.bytes,
		sha256: media.sha256,
		status: media.status,
		deduped
	};
}

export type AttachMediaInput = {
	updateId: string;
	mediaIds: readonly string[];
	/** The calling agent. Media belonging to anyone else is skipped, not attached. */
	agentId: string;
};

export type AttachMediaResult = {
	/** Ids now on the update, in upload order. */
	attached: string[];
	/** Ids that were not the caller's to attach, or were already spoken for. */
	skipped: string[];
};

/**
 * Point media at an update after the fact (design §5's `attach_media`).
 *
 * The two-step upload means bytes can land after the post they belong to, which
 * is the whole reason this tool exists. Skipping rather than failing is
 * deliberate: an agent retrying `attach_media` after a timeout must not get an
 * error for work that already succeeded.
 *
 * @throws {@link DomainError} `not_found` for an update that does not exist or
 *   has been deleted; `invalid_argument` for an empty, malformed or oversized
 *   list.
 */
export function attachMedia(ctx: DomainContext, input: AttachMediaInput): AttachMediaResult {
	const mediaIds = checkedMediaIds(input.mediaIds);

	const update = findUpdateById(ctx.db, input.updateId);
	if (!update || update.deletedAt !== null) {
		throw notFound(`no such update: ${input.updateId}`);
	}

	// Filtered before the write as well as scoped inside it: the statement can
	// enforce "unclaimed, and this agent's", but not "the bytes actually arrived",
	// and attaching an empty reservation would put a permanently broken tile on
	// the owner's timeline.
	const eligible = mediaIds.filter((id) => {
		const media = findMediaById(ctx.db, id);
		return media !== undefined && media.agentId === input.agentId && media.sha256 !== '';
	});

	const attached =
		eligible.length === 0
			? []
			: attachMediaToUpdate(ctx.db, {
					mediaIds: eligible,
					updateId: update.id,
					agentId: input.agentId
				});

	return {
		attached,
		skipped: mediaIds.filter((id) => !attached.includes(id))
	};
}

/**
 * The list, deduplicated and checked.
 *
 * Ids are checked for shape here rather than trusted downstream: a media id
 * reaches a path in `$media`, and the only ids that ever should are ones this
 * server minted.
 */
export function checkedMediaIds(mediaIds: readonly string[]): string[] {
	const unique = [...new Set(mediaIds)];

	if (unique.length === 0) throw invalid('media_ids must name at least one upload');
	if (unique.length > MEDIA_PER_UPDATE_MAX) {
		throw invalid(`an update may carry at most ${MEDIA_PER_UPDATE_MAX} media items`);
	}
	for (const id of unique) {
		if (!isId(id)) throw invalid(`not a media id: ${JSON.stringify(id)}`);
	}

	return unique;
}

/**
 * Check that every id is one this agent may attach, before anything is written.
 *
 * `post_update` uses this so that a bad `media_ids` fails the whole post rather
 * than quietly dropping an image the agent believes it published. `attach_media`
 * does not: retrying it must be safe.
 *
 * @throws {@link DomainError} `not_found` for an unknown id, `invalid_argument`
 *   for one belonging to another agent or already attached elsewhere.
 */
export function assertAttachable(
	ctx: DomainContext,
	input: { mediaIds: readonly string[]; agentId: string }
): string[] {
	const mediaIds = checkedMediaIds(input.mediaIds);

	for (const id of mediaIds) {
		const media = findMediaById(ctx.db, id);
		if (!media) throw notFound(`no such media: ${id}`);
		if (media.agentId !== input.agentId) throw invalid(`media ${id} belongs to another agent`);
		if (media.updateId !== null) throw invalid(`media ${id} is already on another update`);
		if (media.sha256 === '') {
			throw invalid(`media ${id} has no bytes yet: PUT the file to its upload_url first`);
		}
	}

	return mediaIds;
}

/**
 * Open one variant of one media item for serving.
 *
 * @throws {@link MediaError} `not_found` — for an unknown id, an unknown
 *   variant, and a variant that has not been generated alike. See
 *   `ingestUpload` on why media's own error type reaches the route.
 */
export function readMediaVariant(
	ctx: DomainContext,
	input: { id: string; variant: Variant },
	settings: MediaSettings = mediaSettings()
): Promise<MediaFile> {
	return openVariant(settings, { db: ctx.db, id: input.id, variant: input.variant });
}

/**
 * Collect media nothing points at (design §3).
 *
 * Called on a timer by {@link startMediaSweeper}, and directly by a test or a
 * one-off cleanup.
 */
export function sweepMedia(
	ctx: DomainContext,
	input: { olderThanMs?: number; limit?: number } = {},
	settings: MediaSettings = mediaSettings()
): Promise<SweepResult> {
	return sweepOrphanedMedia(settings, {
		db: ctx.db,
		now: ctx.now(),
		olderThanMs: input.olderThanMs,
		limit: input.limit
	});
}

/** How often the background sweeper runs. */
export const MEDIA_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

export type MediaSweeperOptions = {
	context?: () => DomainContext;
	intervalMs?: number;
	/** How old an orphan must be. Defaults to the design's hour. */
	olderThanMs?: number;
	/** Read from the environment per tick unless a test supplies them. */
	settings?: () => MediaSettings;
	onError?: (error: unknown) => void;
};

/**
 * Run the sweeper on a timer for the life of the process.
 *
 * Started by `src/hooks.server.ts`, alongside the presence sweeper. Two details
 * are deliberate. It resolves its context *and its settings* per tick, so
 * starting it costs nothing until it first runs and a deployment whose
 * environment is broken logs a sweep failure rather than failing to boot. And
 * every failure is caught — an unhandled rejection from a background timer would
 * take the whole dashboard down to reclaim a screenshot.
 *
 * @returns a function that stops it.
 */
export function startMediaSweeper(options: MediaSweeperOptions = {}): () => void {
	const {
		context: getContext = context,
		intervalMs = MEDIA_SWEEP_INTERVAL_MS,
		olderThanMs,
		settings: getSettings = mediaSettings,
		onError = (error: unknown) => console.error('media sweep failed', error)
	} = options;

	const timer = setInterval(() => {
		try {
			void sweepMedia(getContext(), { olderThanMs }, getSettings()).catch(onError);
		} catch (error) {
			onError(error);
		}
	}, intervalMs);
	// A pending sweep must not keep the process alive at shutdown.
	timer.unref?.();

	return () => clearInterval(timer);
}
