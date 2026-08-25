/**
 * Where bytes live (design §6).
 *
 * ```
 * <DATA_DIR>/media/<id[0:2]>/<id>/original.png     served
 * <DATA_DIR>/media/<id[0:2]>/<id>/thumb-640.webp   served (derivatives, #8)
 * <DATA_DIR>/tmp/uploads/<name>.part               never served
 * ```
 *
 * Two decisions in that picture are security, not housekeeping.
 *
 * **Temp files live outside the media root.** `/media/:id/:variant` can only
 * address something under `<DATA_DIR>/media`, so a half-written upload is
 * unreachable *by construction* — there is no filename check to get wrong, and
 * no way to fetch a body that has not yet been sniffed. The two directories are
 * also siblings, so moving a finished upload into place is a rename on one
 * filesystem rather than a copy.
 *
 * **Nothing an agent sends reaches a path.** The directory comes from a ULID
 * this server minted, checked here with a full-string pattern; the filename
 * comes from the *sniffed* type, never from the agent's declared filename, which
 * is attacker-controlled text and is stored nowhere at all. The two-character
 * shard is there so a directory listing stays usable at a hundred thousand
 * items.
 */
import { isId } from '$db';
import { basename, join, relative, resolve } from 'node:path';
import { mediaInvalid } from './errors';
import { extensionForMime } from './mime';
import type { MediaSettings } from './settings';

/** Served tree: every file under here is addressable as some `/media/:id/:variant`. */
export function mediaRoot(settings: MediaSettings): string {
	return join(settings.dataDir, 'media');
}

/** In-progress uploads. Deliberately not under {@link mediaRoot}. */
export function tempUploadRoot(settings: MediaSettings): string {
	return join(settings.dataDir, 'tmp', 'uploads');
}

/** A ULID, or nothing goes near a path. */
function checkedId(id: string): string {
	if (!isId(id)) throw mediaInvalid(`not a media id: ${JSON.stringify(id)}`);
	return id;
}

/** The directory holding one media item's original and its derivatives. */
export function mediaDir(settings: MediaSettings, id: string): string {
	const checked = checkedId(id);
	return join(mediaRoot(settings), checked.slice(0, 2), checked);
}

/**
 * File name of the original, from its type.
 *
 * @throws {@link MediaError} for a type outside the allowlist — an unservable
 *   file should never get a name, let alone a place on disk.
 */
export function originalName(mime: string): string {
	const extension = extensionForMime(mime);
	if (!extension) throw mediaInvalid(`type is not on the allowlist: ${JSON.stringify(mime)}`);
	return `original.${extension}`;
}

/** Full path of one media item's original. */
export function originalFile(settings: MediaSettings, id: string, mime: string): string {
	return join(mediaDir(settings, id), originalName(mime));
}

/** Full path of a temp upload. The name is reduced to its last segment first. */
export function tempUploadFile(settings: MediaSettings, name: string): string {
	return join(tempUploadRoot(settings), basename(name));
}

/**
 * A derivative's path, as `derivatives.path` stores it: relative to the media root.
 *
 * Re-checked on the way out even though only this application writes those rows.
 * A path from a table is still a path, and the cost of being sure it stays under
 * the media root is one `relative()`.
 *
 * @throws {@link MediaError} if the stored path escapes the media root.
 */
export function derivativeFile(settings: MediaSettings, storedPath: string): string {
	const root = resolve(mediaRoot(settings));
	const full = resolve(root, storedPath);
	const inside = relative(root, full);

	if (inside === '' || inside.startsWith('..') || resolve(root, inside) !== full) {
		throw mediaInvalid(`derivative path is outside the media root: ${JSON.stringify(storedPath)}`);
	}

	return full;
}
