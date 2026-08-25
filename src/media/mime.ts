/**
 * What this deployment will accept, and how it decides (design §6, §8).
 *
 * Two rules, and the second is the one that matters:
 *
 * - **An allowlist, never a denylist.** Seven types are servable; everything
 *   else is refused. A denylist is a promise to have thought of every dangerous
 *   format, which nobody can keep.
 * - **A declared mime is a claim, not a fact.** `sniffMime` reads the magic
 *   bytes, and `ingest` refuses an upload whose bytes disagree with its claim.
 *   That is what stops a zip renamed `.png`, and it is why the sniff only needs
 *   a header: the verdict lands after {@link SNIFF_BYTES} bytes, long before a
 *   large body has finished arriving.
 *
 * **SVG is absent on purpose.** It is XML with `<script>` in it, so serving one
 * from this origin would hand an agent script execution in the owner's browser
 * (design §6). It is not "not implemented yet"; it must never be added.
 */
import type { MediaKind } from '$db';
import { fileTypeFromBuffer } from 'file-type';

/** Still images the dashboard accepts, in the order design §6 lists them. */
export const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

/** Video the dashboard accepts. `video/quicktime` is what a Mac screen recording is. */
export const VIDEO_MIMES = ['video/mp4', 'video/webm', 'video/quicktime'] as const;

/** The whole allowlist. Nothing outside this is ingested, and nothing outside it is served. */
export const ALLOWED_MIMES = [...IMAGE_MIMES, ...VIDEO_MIMES] as const;

/** One of the seven types this deployment handles. */
export type AllowedMime = (typeof ALLOWED_MIMES)[number];

/**
 * How much of a body the sniffer needs.
 *
 * `file-type`'s own "reasonable detection size": every container this allowlist
 * names declares itself well inside it. Ingest therefore buffers this much and
 * no more, which is what lets an upload be rejected mid-stream on type as well
 * as on size.
 */
export const SNIFF_BYTES = 4100;

/** Extension the original is stored under, per type. Never taken from the filename. */
const EXTENSIONS: Record<AllowedMime, string> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/webp': 'webp',
	'image/gif': 'gif',
	'video/mp4': 'mp4',
	'video/webm': 'webm',
	'video/quicktime': 'mov'
};

/**
 * Reduce a declared mime to the form the allowlist is written in.
 *
 * Tolerant of what a real client sends — case, padding, a `; charset=` a library
 * added — and of nonsense, which it turns into `''` so the allowlist gets to
 * refuse it rather than this function throwing.
 */
export function normaliseMime(raw: string): string {
	return (raw.split(';')[0] ?? '').trim().toLowerCase();
}

/** Is this one of the seven? */
export function isAllowedMime(mime: string): mime is AllowedMime {
	return (ALLOWED_MIMES as readonly string[]).includes(mime);
}

/** Which column value `media.kind` gets, or `undefined` for a type we refuse. */
export function kindForMime(mime: string): MediaKind | undefined {
	if ((IMAGE_MIMES as readonly string[]).includes(mime)) return 'image';
	if ((VIDEO_MIMES as readonly string[]).includes(mime)) return 'video';
	return undefined;
}

/**
 * File extension for an allowed type.
 *
 * The extension comes from the *type*, never from the agent's filename: a
 * filename is attacker-controlled text and has no business anywhere near a path.
 */
export function extensionForMime(mime: string): string | undefined {
	return isAllowedMime(mime) ? EXTENSIONS[mime] : undefined;
}

/**
 * The real type of these bytes, or `undefined` when nothing recognises them.
 *
 * `undefined` is a rejection at every call site, which is what makes SVG,
 * plain text and truncated garbage all fail the same way: no magic bytes, no
 * upload.
 */
export async function sniffMime(head: Uint8Array): Promise<string | undefined> {
	if (head.length === 0) return undefined;
	const found = await fileTypeFromBuffer(head);
	return found?.mime;
}
