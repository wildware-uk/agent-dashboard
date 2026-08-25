/**
 * Serving media (design §6, §8).
 *
 * `/media/:id/:variant` is a **closed set of addresses**. The id must be a ULID
 * with a row behind it, the variant must be one of {@link VARIANTS}, and the
 * filename comes from the variant rather than from the request — so there is no
 * string in the URL that reaches a path, and no way to name a file this function
 * did not intend to offer. The raw upload directory is not merely unlisted: it
 * lives outside the media root (`./paths.ts`), so nothing addressable is in it.
 *
 * Three refusals matter more than they look:
 *
 * - **An unrecognised mime is a 404, not a download.** Only the seven allowlisted
 *   types are ever emitted, checked against the row on the way out as well as
 *   against the bytes on the way in. A row that somehow holds `image/svg+xml`
 *   serves nothing.
 * - **A row with no hash has no bytes.** A reservation whose upload never
 *   happened, or failed, is indistinguishable from a missing item to a caller.
 * - **A path out of the database is still re-checked** against the media root.
 *
 * The path itself never leaves this module: callers get metadata and an `open()`
 * that hands back a stream, which is what lets `$http` serve a 200MB video
 * without reading it into memory and without learning where anything lives.
 */
import {
	findDerivative,
	findMediaById,
	isId,
	listDerivatives,
	type Db,
	type DerivativeKind
} from '$db';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { mediaNotFound } from './errors';
import { isAllowedMime } from './mime';
import { derivativeFile, originalFile } from './paths';
import type { MediaSettings } from './settings';

/**
 * Every address `/media/:id/:variant` accepts.
 *
 * `original` is what this slice produces; the rest are the derivative pipeline's
 * outputs (design §6 step 4), served the moment a row exists for them.
 */
export const VARIANTS = ['original', 'thumb-640', 'thumb-1600', 'poster', 'video'] as const;

export type Variant = (typeof VARIANTS)[number];

/** Is this string one of the addresses we offer? */
export function isVariant(value: string): value is Variant {
	return (VARIANTS as readonly string[]).includes(value);
}

/** The type each derivative is always generated in (design §6). */
const DERIVATIVE_MIMES = {
	'thumb-640': 'image/webp',
	'thumb-1600': 'image/webp',
	poster: 'image/jpeg',
	video: 'video/mp4'
} as const satisfies Record<Exclude<Variant, 'original'>, string>;

/** Which `derivatives` row backs each variant. */
const DERIVATIVE_ROWS = {
	'thumb-640': { kind: 'thumb', width: 640 },
	'thumb-1600': { kind: 'thumb', width: 1600 },
	poster: { kind: 'poster', width: null },
	video: { kind: 'mp4', width: null }
} as const satisfies Record<
	Exclude<Variant, 'original'>,
	{ kind: DerivativeKind; width: number | null }
>;

/** An inclusive byte span, as HTTP counts them. */
export type ByteRange = { start: number; end: number };

/** One servable file. The path stays inside this module; callers get `open()`. */
export type MediaFile = {
	mediaId: string;
	variant: Variant;
	/** Always one of the allowlisted types. */
	mime: string;
	bytes: number;
	/** Strong validator, safe to use with `immutable` because content never changes. */
	etag: string;
	/**
	 * A fresh stream of the bytes, for a response body.
	 *
	 * With `range`, only that inclusive byte span is read — which is what makes a
	 * `206` cheap: seeking a video asks for a window near the end of the file, and
	 * streaming the whole thing to satisfy it would defeat the point.
	 */
	open: (range?: ByteRange) => ReadableStream<Uint8Array>;
};

/**
 * Open one variant for serving.
 *
 * @throws {@link MediaError} `not_found` for everything: an unknown id, a
 *   malformed one, a variant that has not been generated, an upload that never
 *   landed, and a row this deployment refuses to emit are one answer to a
 *   caller, because telling them apart is an inventory of what exists.
 */
export async function openVariant(
	settings: MediaSettings,
	options: { db: Db; id: string; variant: Variant }
): Promise<MediaFile> {
	const { db, id, variant } = options;

	if (!isId(id) || !isVariant(variant)) throw missing();

	const media = findMediaById(db, id);
	if (!media || media.status === 'failed') throw missing();
	// Never emit a type this deployment would not have accepted.
	if (!isAllowedMime(media.mime)) throw missing();

	const found =
		variant === 'original'
			? originalOf(settings, media.id, media.mime, media.sha256)
			: derivativeOf(settings, { db, id: media.id, variant });

	if (!found) throw missing();

	const size = await stat(found.path).catch(() => undefined);
	if (!size?.isFile()) throw missing();

	return {
		mediaId: media.id,
		variant,
		mime: found.mime,
		bytes: size.size,
		// Content at a given address never changes, so the hash of the original
		// plus the variant name is a complete validator.
		etag: `"${media.sha256}-${variant}"`,
		open: (range?: ByteRange) =>
			Readable.toWeb(
				range
					? createReadStream(found.path, { start: range.start, end: range.end })
					: createReadStream(found.path)
			) as ReadableStream<Uint8Array>
	};
}

function missing() {
	return mediaNotFound('no such media');
}

function originalOf(
	settings: MediaSettings,
	id: string,
	mime: string,
	sha256: string
): { path: string; mime: string } | undefined {
	// An empty hash is a reservation whose bytes never arrived (`./upload.ts`).
	if (sha256 === '') return undefined;
	return { path: originalFile(settings, id, mime), mime };
}

function derivativeOf(
	settings: MediaSettings,
	options: { db: Db; id: string; variant: Exclude<Variant, 'original'> }
): { path: string; mime: string } | undefined {
	const wanted = DERIVATIVE_ROWS[options.variant];
	const row = findDerivative(options.db, options.id, wanted.kind, wanted.width);
	if (!row) return undefined;

	try {
		return { path: derivativeFile(settings, row.path), mime: DERIVATIVE_MIMES[options.variant] };
	} catch {
		// A stored path that escapes the media root is a bug, and serving it would
		// be the consequence. Behave as though the derivative does not exist.
		return undefined;
	}
}

/** One entry of what a media item currently offers. */
export type AvailableVariant = {
	variant: Variant;
	mime: string;
	bytes: number;
	width: number | null;
	height: number | null;
};

/**
 * What is available for one media item, for a UI deciding what to render.
 *
 * Reads rows only — a caller learns which addresses will answer, never a path.
 * `original` is listed whenever its bytes have landed; the rest appear as the
 * derivative pipeline produces them.
 */
export function derivativesFor(options: { db: Db; id: string }): AvailableVariant[] {
	const media = findMediaById(options.db, options.id);
	if (!media || media.status === 'failed' || !isAllowedMime(media.mime)) return [];

	const available: AvailableVariant[] = [];

	if (media.sha256 !== '') {
		available.push({
			variant: 'original',
			mime: media.mime,
			bytes: media.bytes,
			width: media.width,
			height: media.height
		});
	}

	for (const row of listDerivatives(options.db, media.id)) {
		const variant = variantOf(row.kind, row.width);
		if (!variant) continue;
		available.push({
			variant,
			mime: DERIVATIVE_MIMES[variant],
			bytes: row.bytes,
			width: row.width,
			height: row.height
		});
	}

	return available;
}

function variantOf(
	kind: DerivativeKind,
	width: number | null
): Exclude<Variant, 'original'> | undefined {
	for (const [variant, wanted] of Object.entries(DERIVATIVE_ROWS)) {
		if (wanted.kind !== kind) continue;
		if (wanted.width !== null && wanted.width !== width) continue;
		return variant as Exclude<Variant, 'original'>;
	}
	return undefined;
}
