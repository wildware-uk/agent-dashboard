import { describe, expect, it } from 'vitest';
import {
	ALLOWED_MIMES,
	SNIFF_BYTES,
	extensionForMime,
	isAllowedMime,
	kindForMime,
	normaliseMime,
	sniffMime
} from './mime';
import {
	gifBytes,
	jpegBytes,
	movBytes,
	mp4Bytes,
	pngBytes,
	svgBytes,
	webmBytes,
	webpBytes,
	zipBytes
} from './testing';

describe('the allowlist', () => {
	it('is exactly the seven types the design names', () => {
		expect([...ALLOWED_MIMES]).toEqual([
			'image/png',
			'image/jpeg',
			'image/webp',
			'image/gif',
			'video/mp4',
			'video/webm',
			'video/quicktime'
		]);
	});

	it('rejects svg, which is a script-execution vector', () => {
		expect(isAllowedMime('image/svg+xml')).toBe(false);
		expect(kindForMime('image/svg+xml')).toBeUndefined();
	});

	it('rejects everything else an agent might try', () => {
		for (const mime of [
			'application/zip',
			'application/xml',
			'text/html',
			'application/pdf',
			'image/tiff',
			'video/x-msvideo',
			''
		]) {
			expect(isAllowedMime(mime), mime).toBe(false);
		}
	});

	it('sorts each type into the kind the media table stores', () => {
		expect(kindForMime('image/png')).toBe('image');
		expect(kindForMime('image/gif')).toBe('image');
		expect(kindForMime('video/quicktime')).toBe('video');
	});

	it('gives every allowed type the extension its file is stored under', () => {
		expect(ALLOWED_MIMES.map((mime) => extensionForMime(mime))).toEqual([
			'png',
			'jpg',
			'webp',
			'gif',
			'mp4',
			'webm',
			'mov'
		]);
		expect(extensionForMime('image/svg+xml')).toBeUndefined();
	});
});

describe('normalising a declared mime', () => {
	it('lowercases, trims, and drops parameters', () => {
		expect(normaliseMime('  IMAGE/PNG  ')).toBe('image/png');
		expect(normaliseMime('image/jpeg; charset=binary')).toBe('image/jpeg');
		expect(normaliseMime('Video/MP4')).toBe('video/mp4');
	});

	it('survives rubbish without throwing, so the allowlist gets to refuse it', () => {
		expect(normaliseMime('')).toBe('');
		expect(normaliseMime(';;;')).toBe('');
		expect(isAllowedMime(normaliseMime('image/png '))).toBe(true);
	});
});

describe('sniffing the real type from magic bytes', () => {
	it('reads each allowed type out of its own header', async () => {
		await expect(sniffMime(pngBytes())).resolves.toBe('image/png');
		await expect(sniffMime(jpegBytes())).resolves.toBe('image/jpeg');
		await expect(sniffMime(webpBytes())).resolves.toBe('image/webp');
		await expect(sniffMime(gifBytes())).resolves.toBe('image/gif');
		await expect(sniffMime(mp4Bytes())).resolves.toBe('video/mp4');
		await expect(sniffMime(webmBytes())).resolves.toBe('video/webm');
		await expect(sniffMime(movBytes())).resolves.toBe('video/quicktime');
	});

	it('is not fooled by a zip claiming to be a png', async () => {
		const sniffed = await sniffMime(zipBytes());

		expect(sniffed).toBe('application/zip');
		expect(isAllowedMime(sniffed ?? '')).toBe(false);
	});

	it('never reports svg as an image: xml has no magic bytes worth trusting', async () => {
		const sniffed = await sniffMime(svgBytes());

		expect(isAllowedMime(sniffed ?? '')).toBe(false);
	});

	it('reports nothing at all for bytes it does not recognise', async () => {
		await expect(sniffMime(new Uint8Array(64))).resolves.toBeUndefined();
		await expect(sniffMime(new Uint8Array(0))).resolves.toBeUndefined();
	});

	it('needs only a header, so a stream can be judged before it finishes', () => {
		expect(SNIFF_BYTES).toBeGreaterThanOrEqual(4100);
		expect(pngBytes().length).toBeLessThan(SNIFF_BYTES);
	});
});
