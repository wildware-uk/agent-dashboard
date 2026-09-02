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
import {
	attachMediaToUpdate,
	findMediaById,
	findUpdateById,
	isId,
	listMediaForMessage,
	listMediaForUpdate,
	type Media,
	type MediaKind,
	type MediaStatus
} from '$db';
import {
	createOwnerMedia,
	createUpload as mintUpload,
	storeBytes,
	derivativesFor,
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
/** {@link translating}, for a body that can reject rather than throw. */
async function translatingAsync<T>(body: () => Promise<T>): Promise<T> {
	try {
		return await body();
	} catch (error) {
		const translated = asDomainError(error);
		if (translated) throw translated;
		throw error;
	}
}

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

export type OwnerUploadInput = {
	filename: string;
	mime: string;
	body: ReadableStream<Uint8Array> | null;
	/** `Content-Length`, if the browser sent one. Never trusted for the cap. */
	contentLength?: number | null;
};

/**
 * Take an image the owner uploaded, in one request.
 *
 * No token, and that is the whole difference from {@link createUpload}: an agent
 * is remote and MCP cannot carry bytes, so it gets a single-use URL to PUT to.
 * The owner's browser puts the bytes on a request that already carries their
 * session cookie, so a token would authorise what is already authorised — and
 * `upload_tokens.agent_id` has nobody to fill it in.
 *
 * Everything after that is the same pipeline: the same allowlist, the same
 * per-kind cap, the same sniffing, the same place on disk. A second pipeline
 * would be a second answer to "is this really a PNG", and one of them would be
 * wrong.
 *
 * @throws {@link DomainError} `invalid_argument` for a type off the allowlist,
 *   a body that never arrived, or bytes past the cap.
 */
export async function uploadOwnerMedia(
	ctx: DomainContext,
	input: OwnerUploadInput,
	settings: MediaSettings = mediaSettings()
): Promise<Media> {
	if (!input.body) throw invalid('the request carried no body');

	// `translating` unwraps a synchronous throw; this path is asynchronous, so the
	// rejection is translated here rather than slipping past as a `MediaError`
	// the HTTP layer would answer 500 to.
	return translatingAsync(async () => {
		const { media, maxBytes, allowed } = createOwnerMedia(settings, {
			db: ctx.db,
			filename: input.filename,
			mime: input.mime,
			bytes: input.contentLength ?? undefined,
			now: ctx.now()
		});

		const stored = await storeBytes(settings, {
			db: ctx.db,
			media,
			body: input.body!,
			maxBytes,
			allowed,
			contentLength: input.contentLength
		});

		return stored.media;
	});
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
 * @throws {@link DomainError} `not_found` for an update that does not exist,
 *   has been deleted, or belongs to another agent; `invalid_argument` for an
 *   empty, malformed or oversized list.
 */
export function attachMedia(ctx: DomainContext, input: AttachMediaInput): AttachMediaResult {
	const mediaIds = checkedMediaIds(input.mediaIds);

	const update = findUpdateById(ctx.db, input.updateId);
	if (!update || update.deletedAt !== null) {
		throw notFound(`no such update: ${input.updateId}`);
	}

	// The tool says "an update YOU have already posted", so check it. Media
	// ownership was filtered below but the update's was not, which let one agent
	// hang an image on another agent's card. Answered as `not_found` rather than a
	// distinct code: whether an id exists but belongs to someone else is not an
	// agent's business.
	if (update.agentId !== input.agentId) {
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
/**
 * The same check as {@link assertAttachable}, for a message rather than a card.
 *
 * Keyed on `author` because the owner uploads too and has no agent id: `human`
 * or `agent:<id>` is the one question both can be asked. Everything else is the
 * same rule and for the same reasons — an image with no bytes is a placeholder,
 * and an image already attached belongs to whatever it is on.
 *
 * @throws {@link DomainError} `not_found` for an unknown id,
 *   `invalid_argument` for one that is not the caller's, is already attached, or
 *   has no bytes.
 */
export function assertAttachableToMessage(
	ctx: DomainContext,
	input: { mediaIds: readonly string[]; author: string }
): string[] {
	const mediaIds = checkedMediaIds(input.mediaIds);

	for (const id of mediaIds) {
		const media = findMediaById(ctx.db, id);
		if (!media) throw notFound(`no such media: ${id}`);
		if (media.author !== input.author) throw invalid(`media ${id} was uploaded by somebody else`);
		if (media.updateId !== null) throw invalid(`media ${id} is already on an update`);
		if (media.messageId !== null) throw invalid(`media ${id} is already on another message`);
		if (media.sha256 === '') {
			throw invalid(`media ${id} has no bytes yet: upload the file first`);
		}
	}

	return mediaIds;
}

/**
 * The bytes of one attachment, small enough to hand to a language model
 * (migration 016).
 *
 * An agent cannot fetch `/media/:id/:variant`: that route wants the owner's
 * session (design §8), and an agent's bearer token is deliberately not a
 * licence to walk the media tree. So the only way a picture ever reaches the
 * agent being asked about it is inside a tool result — which is what this
 * exists to fill.
 *
 * A derivative before the original, because `thumb-1600` is the same screenshot
 * at a tenth of the size and is what the dashboard itself shows. `null` for
 * anything that cannot be read: a variant the pipeline has not written yet, a
 * file that has gone, a picture past `maxBytes`. The caller says so in words
 * rather than failing the read — an unreadable thumbnail must not cost an agent
 * the message it came with.
 */
export type AttachmentBytes = { mediaId: string; mime: string; bytes: Uint8Array };

/** Best first: readable, then small, then whatever was uploaded. */
const INLINE_VARIANTS: readonly Variant[] = ['thumb-1600', 'thumb-640', 'original'];

export async function readAttachmentBytes(
	ctx: DomainContext,
	input: { mediaId: string; variants: readonly Variant[]; maxBytes: number },
	settings: MediaSettings = mediaSettings()
): Promise<AttachmentBytes | null> {
	for (const variant of INLINE_VARIANTS) {
		if (!input.variants.includes(variant)) continue;

		try {
			const file = await openVariant(settings, { db: ctx.db, id: input.mediaId, variant });
			// Checked before reading rather than after: the point of a ceiling is not
			// to pull twenty megabytes into memory and then decide against it.
			if (file.bytes > input.maxBytes) continue;

			const bytes = new Uint8Array(await new Response(file.open()).arrayBuffer());
			return { mediaId: input.mediaId, mime: file.mime, bytes };
		} catch {
			// Not written yet, or gone. Try the next variant; `null` says so in the end.
		}
	}

	return null;
}

/** Every image on one message, for the card that renders it. */
export function listMessageMedia(ctx: DomainContext, messageId: string): MediaAttachment[] {
	return listMediaForMessage(ctx.db, messageId).map((row) => attachment(ctx, row));
}

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
 * One media item as a browser renders it (design §6 step 5, §7).
 *
 * Three fields carry the weight. `status` is what the grid switches on: a
 * placeholder while `pending`, a failed state on `failed`, the asset on `ready`.
 * `width`/`height` are the *stored* dimensions, which is what lets a cell
 * reserve its box before a byte has loaded, so the timeline does not jump as
 * images arrive. And `variants` is the set of `/media/:id/:variant` addresses
 * that will actually answer right now, so the browser never asks for one that
 * would 404 — which matters most for video, because a web-playable mp4 gets no
 * transcode (`src/media/derive.ts`) and has to be played from `original`.
 *
 * No URLs: an address is `/media/:id/:variant` for every deployment, so sending
 * five strings per item would be five copies of a rule the client already has.
 */
// Re-exported so adapters can name the settings without importing `$media`
// directly: `$mcp` may see the domain and nothing below it (design §2).
export { mediaSettings };
export type { MediaSettings };

export type MediaAttachment = {
	id: string;
	updateId: string | null;
	/** The message this is on, for an image in a reply or one of the owner's posts. */
	messageId: string | null;
	kind: MediaKind;
	mime: string;
	status: MediaStatus;
	/** Measured by the pipeline; `null` until it has run. */
	width: number | null;
	height: number | null;
	durationMs: number | null;
	/** Which variants exist. Empty for a row with no bytes, and for a failure. */
	variants: Variant[];
};

/** One row as a card renders it, with the variants that exist right now. */
function attachment(ctx: DomainContext, row: Media): MediaAttachment {
	return {
		id: row.id,
		updateId: row.updateId,
		messageId: row.messageId,
		kind: row.kind,
		mime: row.mime,
		status: row.status,
		width: row.width,
		height: row.height,
		durationMs: row.durationMs,
		variants: derivativesFor({ db: ctx.db, id: row.id }).map((available) => available.variant)
	};
}

/**
 * The media on a page of updates, grouped by update.
 *
 * Read as a second query rather than folded into `listUpdates`, because the
 * timeline is the same list whether or not a caller cares about media, and
 * because this is the read that `media.ready` makes stale: a browser hearing
 * that event refetches the page it is showing and gets the new variants here,
 * with no other part of the snapshot having to know why (design §4).
 *
 * Updates with nothing attached are absent rather than present-and-empty, so a
 * timeline of plain text costs one key per page instead of fifty.
 *
 * One query per update, deliberately: the alternative is a variadic `IN (...)`
 * in `$db` for a page of at most 200 rows against a local SQLite file, and the
 * per-item derivative read would still be there. `derivativesFor` is asked
 * rather than reimplemented so that the variant vocabulary has exactly one
 * definition, in the module that serves it.
 */
export function listUpdateMedia(
	ctx: DomainContext,
	updateIds: readonly string[]
): Record<string, MediaAttachment[]> {
	const byUpdate: Record<string, MediaAttachment[]> = {};

	for (const updateId of updateIds) {
		const rows = listMediaForUpdate(ctx.db, updateId);
		if (rows.length === 0) continue;

		byUpdate[updateId] = rows.map((row) => attachment(ctx, row));
	}

	return byUpdate;
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
