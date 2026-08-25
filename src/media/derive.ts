/**
 * Turning one uploaded original into the things a browser can render
 * (design §6 steps 4-5).
 *
 * This is the whole of "produce derivatives" for a single media item, written so
 * that the queue above it (`./queue.ts`) has nothing to reason about: it
 * **never throws and never rejects**. Every outcome is a value — `ready`,
 * `failed`, or `skipped` — because a background job that throws is either an
 * unhandled rejection or a `try` somebody forgot.
 *
 * Four decisions are worth reading before the code:
 *
 * - **`ready` is a one-way door, and so is the event.** The first thing this
 *   does is look at the current status; a row that is already `ready` is
 *   skipped. That, plus the queue folding repeat submissions of one media id
 *   into a single run, is what makes `media.ready` fire exactly once per media
 *   even though the worker re-lists the pending rows every tick.
 * - **Thumbnails are resized to exactly their nominal width.** The width in a
 *   `derivatives` row is not decoration — `/media/:id/thumb-640` finds its file
 *   by `(kind, width)` — so a row saying 640 has to be 640 pixels wide. A
 *   source narrower than the target is enlarged rather than stored under a width
 *   that would be a lie about both the file and the address.
 * - **EXIF never survives.** `sharp` applies the orientation tag and then emits
 *   webp with no metadata block at all, so the GPS coordinates in a phone
 *   screenshot do not get served back out of this deployment.
 * - **Rows are written only once every file exists.** A half-derived media item
 *   with a thumbnail row and no poster row would look ready to a UI. If anything
 *   fails, nothing is recorded, the status becomes `failed`, and the reason is
 *   written next to the bytes.
 */
import {
	findMediaById,
	setMediaStatus,
	upsertDerivative,
	type Db,
	type DerivativeKind,
	type Media
} from '$db';
import { bus as defaultBus, type EventBus } from '$events';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { isWebPlayable, posterSeconds, probeVideo, runFfmpeg, type ToolOptions } from './ffmpeg';
import { isAllowedMime } from './mime';
import { derivativeTarget, failureFile, mediaDir, originalFile } from './paths';
import type { MediaSettings } from './settings';

/** The two thumbnail widths of design §6, smallest first. */
export const THUMB_WIDTHS = [640, 1600] as const;

/** webp quality for thumbnails: visually clean, a fraction of the original. */
export const THUMB_QUALITY = 80;

/** ffmpeg's `-q:v` for the poster frame, where 2 is best and 31 is worst. */
export const POSTER_QUALITY = 3;

/** How much of a failure reason is kept. Enough to read, not enough to be a log. */
export const REASON_MAX = 500;

export type DeriveOptions = {
	db: Db;
	/** The media to derive. An unknown id is a skip, not an error. */
	id: string;
	/** Defaults to the application bus. Tests pass their own. */
	bus?: EventBus;
	/**
	 * Redo the work for a row that is already `ready`.
	 *
	 * Rewrites the files and the rows; it deliberately does *not* publish a
	 * second `media.ready`, because nothing new became available.
	 */
	force?: boolean;
	/** Binary paths and timeouts, for tests. Defaults to `PATH`. */
	tools?: { ffmpeg?: ToolOptions; ffprobe?: ToolOptions };
	now?: number;
};

export type DeriveOutcome =
	| {
			status: 'ready';
			mediaId: string;
			/** The variants that now have both a file and a row. */
			variants: string[];
			width: number | null;
			height: number | null;
			durationMs: number | null;
			/** Whether this run is the one that published `media.ready`. */
			published: boolean;
	  }
	| { status: 'failed'; mediaId: string; reason: string }
	| { status: 'skipped'; mediaId: string; reason: string };

/** One generated file, before it becomes a row. */
type Produced = {
	kind: DerivativeKind;
	/** Nominal width for a thumbnail — the address — or the real one otherwise. */
	width: number | null;
	height: number | null;
	/** Media-root-relative, as the row stores it. */
	path: string;
	bytes: number;
	/** The `/media/:id/:variant` this file answers, for the outcome. */
	variant: string;
};

type Measured = {
	files: Produced[];
	width: number | null;
	height: number | null;
	durationMs: number | null;
};

/**
 * Derive everything one media item needs, and record the result.
 *
 * @returns what happened. Never throws: a corrupt file is a `failed` outcome, an
 *   unknown id is a `skipped` one.
 */
export async function processMedia(
	settings: MediaSettings,
	options: DeriveOptions
): Promise<DeriveOutcome> {
	const { db, id } = options;

	const media = findMediaById(db, id);
	if (!media) return skipped(id, 'no such media');
	// A reservation whose PUT never happened. There are no bytes to derive from,
	// and the sweeper will collect it in an hour.
	if (media.sha256 === '') return skipped(id, 'bytes never landed');
	if (media.status === 'ready' && !options.force) return skipped(id, 'already ready');

	if (!isAllowedMime(media.mime)) {
		// Unreachable through ingest, which sniffs; reachable through a hand-edited
		// row, and serving is refused for those too (`./serve.ts`).
		return await fail(settings, options, media, `type is not servable: ${media.mime}`);
	}

	try {
		const measured =
			media.kind === 'video'
				? await deriveVideo(settings, media, options)
				: await deriveImage(settings, media);

		for (const file of measured.files) {
			upsertDerivative(db, {
				mediaId: media.id,
				kind: file.kind,
				path: file.path,
				bytes: file.bytes,
				width: file.width,
				height: file.height
			});
		}

		// Before the status flip, so that nothing awaits between the row becoming
		// `ready` and the event saying so: a subscriber that reads the row on
		// hearing `media.ready` must never see it still `pending`, and a poller
		// that sees `ready` must not have to wait for the event.
		await rm(failureFile(settings, media.id), { force: true }).catch(() => {});

		const updated =
			setMediaStatus(db, media.id, {
				status: 'ready',
				width: measured.width,
				height: measured.height,
				durationMs: measured.durationMs
			}) ?? media;

		// Exactly once per media: this line is only reached when the row was not
		// already `ready`, and `force` says explicitly that nothing new appeared.
		const published = !options.force;
		if (published) {
			(options.bus ?? defaultBus).publish('media.ready', {
				mediaId: updated.id,
				// Read back rather than remembered: an update may have claimed this
				// media while the transcode was running.
				updateId: updated.updateId,
				kind: updated.kind
			});
		}

		return {
			status: 'ready',
			mediaId: media.id,
			variants: measured.files.map((file) => file.variant),
			width: updated.width,
			height: updated.height,
			durationMs: updated.durationMs,
			published
		};
	} catch (error) {
		return await fail(settings, options, media, reasonOf(error));
	}
}

/**
 * Read back why a media item failed.
 *
 * The operator-facing half of the failure record: `media.status` says *that* it
 * failed, this says what the decoder actually complained about.
 */
export async function readMediaFailure(
	settings: MediaSettings,
	id: string
): Promise<string | undefined> {
	try {
		const text = await readFile(failureFile(settings, id), 'utf8');
		return text.trim() || undefined;
	} catch {
		return undefined;
	}
}

function skipped(mediaId: string, reason: string): DeriveOutcome {
	return { status: 'skipped', mediaId, reason };
}

/** Record the failure in all three places it needs to be, and report it. */
async function fail(
	settings: MediaSettings,
	options: DeriveOptions,
	media: Media,
	reason: string
): Promise<DeriveOutcome> {
	setMediaStatus(options.db, media.id, { status: 'failed' });

	try {
		const at = new Date(options.now ?? Date.now()).toISOString();
		await mkdir(mediaDir(settings, media.id), { recursive: true });
		await writeFile(failureFile(settings, media.id), `${at} ${reason}\n`, 'utf8');
	} catch {
		// Failing to write down a failure must not turn into a second failure: the
		// status is already `failed` and the reason is in the returned outcome.
	}

	return { status: 'failed', mediaId: media.id, reason };
}

/** The readable part of whatever went wrong, on one line. */
function reasonOf(error: unknown): string {
	const text =
		error instanceof Error ? error.message || error.name : typeof error === 'string' ? error : '';
	const flat = text.replace(/\s+/g, ' ').trim();
	return (flat || 'unknown failure').slice(0, REASON_MAX);
}

/**
 * Two webp thumbnails, and the original's real dimensions.
 *
 * `rotate()` with no argument is auto-orient: it applies the EXIF orientation
 * tag so a phone photo is not sideways, and then the webp encoder writes no
 * metadata, which is where the EXIF goes. `autoOrient` from `metadata()` is used
 * for the row so `media.width`/`media.height` describe the image as it will be
 * *seen*, not as it happens to be stored.
 */
async function deriveImage(settings: MediaSettings, media: Media): Promise<Measured> {
	const source = originalFile(settings, media.id, media.mime);
	const metadata = await sharp(source).metadata();
	const oriented = metadata.autoOrient ?? { width: metadata.width, height: metadata.height };

	const dir = mediaDir(settings, media.id);
	await mkdir(dir, { recursive: true });

	const files: Produced[] = [];
	for (const width of THUMB_WIDTHS) {
		const target = derivativeTarget(settings, media.id, `thumb-${width}.webp`);
		const info = await sharp(source)
			.rotate()
			.resize({ width })
			.webp({ quality: THUMB_QUALITY })
			.toFile(target.absolute);

		files.push({
			kind: 'thumb',
			// The nominal width, which is also this file's address.
			width,
			height: info.height,
			path: target.relative,
			bytes: info.size,
			variant: `thumb-${width}`
		});
	}

	return {
		files,
		width: oriented.width ?? null,
		height: oriented.height ?? null,
		durationMs: null
	};
}

/**
 * A poster frame, the measurements, and an h264 mp4 if the source needs one.
 *
 * No thumbnails: design §6 gives video a `poster.jpg` and the UI renders that,
 * so generating webp copies of it would be two more files nothing asks for.
 */
async function deriveVideo(
	settings: MediaSettings,
	media: Media,
	options: DeriveOptions
): Promise<Measured> {
	const source = originalFile(settings, media.id, media.mime);
	const probe = await probeVideo(source, options.tools?.ffprobe);

	const dir = mediaDir(settings, media.id);
	await mkdir(dir, { recursive: true });

	const files: Produced[] = [];

	const poster = derivativeTarget(settings, media.id, 'poster.jpg');
	await writePoster(source, poster.absolute, probe.durationMs, options);
	const posterMeta = await sharp(poster.absolute).metadata();
	files.push({
		kind: 'poster',
		width: posterMeta.width ?? probe.width ?? null,
		height: posterMeta.height ?? probe.height ?? null,
		path: poster.relative,
		bytes: (await stat(poster.absolute)).size,
		variant: 'poster'
	});

	if (!isWebPlayable(media.mime, probe)) {
		const video = derivativeTarget(settings, media.id, 'video.mp4');
		await transcode(source, video.absolute, options);
		const transcoded = await probeVideo(video.absolute, options.tools?.ffprobe);
		files.push({
			kind: 'mp4',
			width: transcoded.width,
			height: transcoded.height,
			path: video.relative,
			bytes: (await stat(video.absolute)).size,
			variant: 'video'
		});
	}

	return {
		files,
		width: probe.width ?? posterMeta.width ?? null,
		height: probe.height ?? posterMeta.height ?? null,
		durationMs: probe.durationMs
	};
}

/**
 * One frame, as a jpeg.
 *
 * The retry at zero is not defensive padding: ffmpeg treats a seek past the last
 * frame as *success with no output*, so a clip shorter than the clamp expects —
 * or one whose container lies about its duration — would otherwise leave a
 * missing file and a zero exit status behind, and the failure would surface as
 * "poster.jpg does not exist" three lines later.
 */
async function writePoster(
	source: string,
	target: string,
	durationMs: number | null,
	options: DeriveOptions
): Promise<void> {
	for (const seek of [posterSeconds(durationMs), 0]) {
		await runFfmpeg(
			[
				'-y',
				// Before -i: ffmpeg seeks the container rather than decoding up to the
				// timestamp, which on a large video is the difference between instant
				// and a full decode.
				'-ss',
				String(seek),
				'-i',
				source,
				'-frames:v',
				'1',
				'-an',
				'-q:v',
				String(POSTER_QUALITY),
				'-f',
				'image2',
				target
			],
			options.tools?.ffmpeg
		);

		const written = await stat(target).catch(() => undefined);
		if (written?.isFile() && written.size > 0) return;
	}

	throw new Error('ffmpeg produced no poster frame from this video');
}

/** An h264/aac mp4 a browser will play (design §6 step 4). */
async function transcode(source: string, target: string, options: DeriveOptions): Promise<void> {
	await runFfmpeg(
		[
			'-y',
			'-i',
			source,
			// First video stream, and audio only if there is any: `0:a?` is what
			// stops a silent screen recording failing as "stream not found".
			'-map',
			'0:v:0',
			'-map',
			'0:a?',
			'-c:v',
			'libx264',
			'-preset',
			'veryfast',
			'-crf',
			'23',
			'-pix_fmt',
			'yuv420p',
			// yuv420p needs even dimensions, and an odd-sized screen recording is
			// completely normal.
			'-vf',
			'scale=trunc(iw/2)*2:trunc(ih/2)*2',
			'-c:a',
			'aac',
			'-b:a',
			'128k',
			// The index at the front, so the browser can start playing before the
			// whole file has arrived.
			'-movflags',
			'+faststart',
			target
		],
		options.tools?.ffmpeg
	);

	const written = await stat(target).catch(() => undefined);
	if (!written?.isFile() || written.size === 0) {
		throw new Error('ffmpeg produced no mp4 from this video');
	}
}
