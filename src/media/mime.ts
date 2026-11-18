/**
 * What this deployment will accept, and how it decides (design §6, §8).
 *
 * There are two classes of upload here, and the difference between them is the
 * whole of the security story.
 *
 * **Renderable media — {@link ALLOWED_MIMES}.** Eleven types the dashboard puts
 * on the page: four images, three videos and four sounds (migration 038). They
 * are served inline, from this origin, into the owner's browser, so they get the
 * strict treatment.
 *
 * - **An allowlist, never a denylist.** Those eleven are rendered; everything
 *   else is not. A denylist is a promise to have thought of every dangerous
 *   format, which nobody can keep.
 * - **A declared mime is a claim, not a fact.** `sniffMime` reads the magic
 *   bytes, and `ingest` refuses a renderable upload whose bytes disagree with
 *   its claim. That is what stops a zip renamed `.png`, and it is why the sniff
 *   only needs a header: the verdict lands after {@link SNIFF_BYTES} bytes, long
 *   before a large body has finished arriving.
 *
 * **Everything else — kind `file` (migration 026).** The owner asked to be able
 * to send agents any file, not just pictures, so a PDF, a CSV, a log or a zip is
 * stored too. Those bytes are **never rendered and never served inline**: the
 * route answers `application/octet-stream` with `Content-Disposition:
 * attachment` (`src/http/media/serve.ts`), which is what keeps "any file" from
 * meaning "any script, on the dashboard's own origin". So a file's declared type
 * is a *label* — it is shown next to the download and is not sniffed, because
 * there is no rendering decision for it to get wrong.
 *
 * **SVG is still never renderable.** It is XML with `<script>` in it, so serving
 * one inline from this origin would hand an agent script execution in the
 * owner's browser (design §6). Uploading one as a `file` is fine and always
 * downloads; it must never join {@link ALLOWED_MIMES}.
 */
import type { MediaKind } from '$db';
import { fileTypeFromBuffer } from 'file-type';

/** Still images the dashboard accepts, in the order design §6 lists them. */
export const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

/** Video the dashboard accepts. `video/quicktime` is what a Mac screen recording is. */
export const VIDEO_MIMES = ['video/mp4', 'video/webm', 'video/quicktime'] as const;

/**
 * Sound the dashboard plays (migration 038).
 *
 * The owner: "allow agents and users to attach a number of sound files, that can
 * be played directly in the dashboard."
 *
 * Four containers, because that is what a browser will actually play: MP3, MP4
 * audio (which is what an `.m4a` voice memo is), Ogg/Opus and WAV. Anything else
 * — FLAC, a tracker module, a DAW project — is still perfectly uploadable as a
 * `file` and downloads, which is the honest answer for bytes this dashboard
 * cannot play.
 *
 * `audio/mp4` and `audio/webm` are containers a video type also uses, so the
 * sniffer can report the video spelling for a track with no pictures in it;
 * {@link kindForMime} is not where that is resolved — `ingest` compares the
 * sniffed type against the claim, and a caller who says `audio/mp4` for an
 * `.m4a` gets audio.
 */
export const AUDIO_MIMES = ['audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav'] as const;

/** The whole renderable allowlist. Nothing outside this is ever served inline. */
export const ALLOWED_MIMES = [...IMAGE_MIMES, ...VIDEO_MIMES, ...AUDIO_MIMES] as const;

/** One of the types this deployment renders. */
export type AllowedMime = (typeof ALLOWED_MIMES)[number];

/**
 * What a `file` original is served as, whatever it claims to be.
 *
 * One type for every file, so no declared string a caller invents can decide
 * what the owner's browser does with the bytes.
 */
export const DOWNLOAD_MIME = 'application/octet-stream';

/** Extension a `file` original is stored under. Never taken from the filename. */
export const FILE_EXTENSION = 'bin';

/**
 * A syntactically sane `type/subtype`.
 *
 * The only check a `file` mime gets, and it is not a safety check — it is there
 * so the label beside a download is a mime rather than a paragraph. Length is
 * bounded for the same reason.
 */
const MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$/;

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
	'video/quicktime': 'mov',
	'audio/mpeg': 'mp3',
	'audio/mp4': 'm4a',
	'audio/ogg': 'ogg',
	'audio/wav': 'wav'
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

/** Is this one of the types the dashboard renders? */
export function isAllowedMime(mime: string): mime is AllowedMime {
	return (ALLOWED_MIMES as readonly string[]).includes(mime);
}

/**
 * Is this something we will store as a `file` — a download rather than a render?
 *
 * Anything well formed that is not renderable. Deliberately permissive: the
 * bytes are only ever handed back as an attachment, so the answer to "what is
 * this" costs nothing to get wrong.
 */
export function isFileMime(mime: string): boolean {
	return !isAllowedMime(mime) && MIME_PATTERN.test(mime);
}

/** Which column value `media.kind` gets, or `undefined` for a type we refuse. */
export function kindForMime(mime: string): MediaKind | undefined {
	if ((IMAGE_MIMES as readonly string[]).includes(mime)) return 'image';
	if ((VIDEO_MIMES as readonly string[]).includes(mime)) return 'video';
	if ((AUDIO_MIMES as readonly string[]).includes(mime)) return 'audio';
	if (isFileMime(mime)) return 'file';
	return undefined;
}

/**
 * File extension the original is stored under.
 *
 * The extension comes from the *type*, never from the caller's filename: a
 * filename is attacker-controlled text and has no business anywhere near a path.
 * Every `file` gets {@link FILE_EXTENSION}, which is the same statement in a
 * different form — one extension for everything means nothing a caller declares
 * can pick one.
 */
export function extensionForMime(mime: string): string | undefined {
	if (isAllowedMime(mime)) return EXTENSIONS[mime];
	return isFileMime(mime) ? FILE_EXTENSION : undefined;
}

/**
 * Spellings the sniffer uses for types the allowlist names differently.
 *
 * Real files, checked against `file-type` rather than guessed: an `.m4a` voice
 * memo sniffs as `audio/x-m4a`, an Opus file as `audio/ogg; codecs=opus`. Both
 * are the same container the allowlist already names, under an older or a more
 * specific name, and a caller who declares the canonical type should not be told
 * their own file is a lie.
 *
 * Only ever *narrows* to something already on the allowlist. Nothing here can
 * make a new type servable.
 */
const ALIASES: Record<string, string> = {
	'audio/x-m4a': 'audio/mp4',
	'audio/m4a': 'audio/mp4',
	'audio/x-wav': 'audio/wav',
	'audio/wave': 'audio/wav',
	'audio/vorbis': 'audio/ogg',
	'audio/opus': 'audio/ogg'
};

/** The allowlist's spelling of a type: parameters dropped, aliases resolved. */
export function canonicalMime(raw: string): string {
	const plain = normaliseMime(raw);
	return ALIASES[plain] ?? plain;
}

/**
 * The real type of these bytes, or `undefined` when nothing recognises them.
 *
 * `undefined` is a rejection on the renderable path, which is what makes SVG,
 * plain text and truncated garbage all fail the same way there: no magic bytes,
 * no picture. A `file` upload never asks this question — plain text has no magic
 * bytes and is a perfectly good thing to send an agent.
 *
 * The answer comes back in the allowlist's own spelling, so a caller comparing
 * it against a declared type is comparing like with like.
 */
export async function sniffMime(head: Uint8Array): Promise<string | undefined> {
	if (head.length === 0) return undefined;
	const found = await fileTypeFromBuffer(head);
	return found ? canonicalMime(found.mime) : undefined;
}
