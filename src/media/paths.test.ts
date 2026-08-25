import { newId } from '$db';
import { afterEach, describe, expect, it } from 'vitest';
import { isMediaError } from './errors';
import {
	derivativeFile,
	derivativeTarget,
	failureFile,
	mediaDir,
	mediaRoot,
	originalFile,
	originalName,
	tempUploadFile,
	tempUploadRoot
} from './paths';
import { tempSettings } from './testing';

const temp = tempSettings();
const { settings } = temp;

afterEach(() => temp.cleanup());

describe('the disk layout', () => {
	it('shards media two characters deep under the data directory, as the design writes it', () => {
		const id = '01K3ABCDEFGHJKMNPQRSTVWXYZ';

		expect(mediaRoot(settings)).toBe(`${settings.dataDir}/media`);
		expect(mediaDir(settings, id)).toBe(`${settings.dataDir}/media/01/${id}`);
		expect(originalFile(settings, id, 'image/png')).toBe(
			`${settings.dataDir}/media/01/${id}/original.png`
		);
	});

	it('names the original after its type, never after the filename an agent sent', () => {
		expect(originalName('image/jpeg')).toBe('original.jpg');
		expect(originalName('video/quicktime')).toBe('original.mov');
	});

	it('refuses to name a file for a type outside the allowlist', () => {
		expect(() => originalName('image/svg+xml')).toThrow(/allowlist|type/i);
		expect(() => originalFile(settings, newId(), 'application/zip')).toThrow(/allowlist|type/i);
	});

	it('keeps the raw upload directory outside the served tree', () => {
		// `/media/:id/:variant` can only ever address something under the media
		// root, so a temp file that lives outside it is unreachable by construction
		// rather than by a filename check.
		expect(tempUploadRoot(settings).startsWith(mediaRoot(settings))).toBe(false);
		expect(tempUploadFile(settings, 'abc').startsWith(tempUploadRoot(settings))).toBe(true);
	});
});

describe('an id is never pasted into a path unchecked', () => {
	it('rejects traversal, separators and anything that is not a ULID', () => {
		for (const id of [
			'../../etc/passwd',
			'..',
			'a/b',
			'01K3ABCDEFGHJKMNPQRSTVWXY',
			'01k3abcdefghjkmnpqrstvwxyz',
			'',
			'01K3ABCDEFGHJKMNPQRSTVWXYZ/..'
		]) {
			const failure = (() => {
				try {
					mediaDir(settings, id);
					return undefined;
				} catch (error) {
					return error;
				}
			})();

			expect(isMediaError(failure), `accepted ${JSON.stringify(id)}`).toBe(true);
		}
	});

	it('sanitises a temp file name down to something that cannot escape', () => {
		expect(tempUploadFile(settings, '../../escape')).toBe(`${tempUploadRoot(settings)}/escape`);
	});
});

describe('a derivative path from the database', () => {
	it('resolves relative to the media root', () => {
		const id = newId();

		expect(derivativeFile(settings, `${id.slice(0, 2)}/${id}/thumb-640.webp`)).toBe(
			`${mediaRoot(settings)}/${id.slice(0, 2)}/${id}/thumb-640.webp`
		);
	});

	it('refuses a stored path that climbs out of the media root', () => {
		expect(() => derivativeFile(settings, '../../etc/passwd')).toThrow();
		expect(() => derivativeFile(settings, '/etc/passwd')).toThrow();
	});
});

describe('where a derivative goes', () => {
	it('gives the row its media-root-relative path and the writer its absolute one', () => {
		const id = newId();

		expect(derivativeTarget(settings, id, 'thumb-640.webp')).toEqual({
			relative: `${id.slice(0, 2)}/${id}/thumb-640.webp`,
			absolute: `${mediaDir(settings, id)}/thumb-640.webp`
		});
	});

	it('round-trips through the check the serving path applies to a stored path', () => {
		const id = newId();
		const target = derivativeTarget(settings, id, 'poster.jpg');

		expect(derivativeFile(settings, target.relative)).toBe(target.absolute);
	});

	it('stores the path with forward slashes, so the row means the same on any host', () => {
		expect(derivativeTarget(settings, newId(), 'video.mp4').relative).not.toContain('\\');
	});

	it('refuses an id it did not mint, before anything is written', () => {
		expect(() => derivativeTarget(settings, '../../etc', 'poster.jpg')).toThrow();
		expect(() => failureFile(settings, 'not-an-id')).toThrow();
	});
});

describe('the failure note', () => {
	it('sits beside the bytes and is not a variant, so nothing can serve it', () => {
		const id = newId();

		expect(failureFile(settings, id)).toBe(`${mediaDir(settings, id)}/error.txt`);
	});
});
