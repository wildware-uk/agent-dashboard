import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as media from './index';

describe('the $media surface', () => {
	it('exposes the things a caller does, plus its settings reader', () => {
		for (const name of [
			'createUpload',
			'ingest',
			'openVariant',
			'derivativesFor',
			'sweepOrphanedMedia',
			'mediaSettings',
			// The derivative pipeline (design §6 steps 4-5): one item, the whole
			// backlog, and the background worker that does it on a timer.
			'processMedia',
			'processPendingMedia',
			'startDerivativeWorker',
			'readMediaFailure'
		] as const) {
			expect(media[name], name).toBeTypeOf('function');
		}
	});

	it('never exposes a path', () => {
		// Design §2: "callers get `ingest()` and `derivativesFor()`; they never
		// learn where a file lives on disk". `./paths.ts` is internal, and a
		// refactor that re-exports it should fail here rather than in a route.
		for (const name of [
			'mediaRoot',
			'mediaDir',
			'originalFile',
			'derivativeFile',
			'derivativeTarget',
			'failureFile',
			'tempUploadRoot',
			'tempUploadFile'
		]) {
			expect(Object.keys(media), name).not.toContain(name);
		}
	});

	it('keeps the test fixtures out of the production entry point', () => {
		expect(Object.keys(media)).not.toContain('tempSettings');
		expect(Object.keys(media)).not.toContain('pngBytes');
	});

	it('signs and verifies tokens without handing the verifier out', () => {
		// Minting is `createUpload`'s job and spending is `ingest`'s. Nothing
		// outside this module has a reason to parse a token, and something that
		// could would be a second place upload authorisation is decided.
		expect(Object.keys(media)).not.toContain('parseUploadToken');
		expect(Object.keys(media)).not.toContain('signUploadToken');
	});
});

describe('the module boundary', () => {
	it('imports no adapter, in any file it ships', () => {
		const files = readdirSync(import.meta.dirname).filter(
			(entry) => entry.endsWith('.ts') && !/\.(test|spec)\.ts$/.test(entry)
		);

		expect(files.length).toBeGreaterThan(5);

		const offenders = files.filter((file) =>
			/from\s*['"](\$http|\$mcp|\$domain|\$web)/.test(
				readFileSync(join(import.meta.dirname, file), 'utf8')
			)
		);

		expect(offenders).toEqual([]);
	});

	it('leaves SVG out of the allowlist, permanently', () => {
		// Not a "not yet": an SVG served from this origin is script execution in
		// the owner's browser (design §6, §8).
		expect([...media.ALLOWED_MIMES]).not.toContain('image/svg+xml');
		expect(media.isAllowedMime('image/svg+xml')).toBe(false);
	});
});

describe('the derivative pipeline surface', () => {
	it('produces the two thumbnail widths the design names', () => {
		expect([...media.THUMB_WIDTHS]).toEqual([640, 1600]);
	});

	it('runs two jobs at a time', () => {
		expect(media.DEFAULT_CONCURRENCY).toBe(2);
	});

	it('takes the poster frame at one second', () => {
		expect(media.POSTER_AT_S).toBe(1);
	});
});
