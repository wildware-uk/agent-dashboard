import { describe, expect, it } from 'vitest';
import {
	ALLOWED_MIMES,
	AUDIO_MIMES,
	SNIFF_BYTES,
	canonicalMime,
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
	sampleAudioBytes,
	webmBytes,
	webpBytes,
	zipBytes
} from './testing';

describe('the allowlist', () => {
	it('is exactly the types the design names, and sound (migration 038)', () => {
		expect([...ALLOWED_MIMES]).toEqual([
			'image/png',
			'image/jpeg',
			'image/webp',
			'image/gif',
			'video/mp4',
			'video/webm',
			'video/quicktime',
			'audio/mpeg',
			'audio/mp4',
			'audio/ogg',
			'audio/wav'
		]);
	});

	it('never renders svg, which is a script-execution vector', () => {
		// It may be *stored* — as a `file`, which downloads (migration 026) — but it
		// is never one of the types this deployment puts on a page.
		expect(isAllowedMime('image/svg+xml')).toBe(false);
		expect(kindForMime('image/svg+xml')).toBe('file');
	});

	it('renders none of the types an agent might hope for', () => {
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

	it('stores anything well formed that it will not render, as a file', () => {
		for (const mime of ['application/pdf', 'text/plain', 'application/zip', 'text/csv']) {
			expect(kindForMime(mime), mime).toBe('file');
		}
	});

	it('refuses a declared type that is not a type at all', () => {
		// The one refusal left: not a safety check, but the difference between a
		// label beside a download and a paragraph beside one.
		for (const mime of ['', 'pdf', 'application/', '/pdf', 'a b/c', 'x'.repeat(200) + '/y']) {
			expect(kindForMime(mime), JSON.stringify(mime)).toBeUndefined();
		}
	});

	it('sorts each type into the kind the media table stores', () => {
		expect(kindForMime('image/png')).toBe('image');
		expect(kindForMime('image/gif')).toBe('image');
		expect(kindForMime('video/quicktime')).toBe('video');
		expect(kindForMime('application/pdf')).toBe('file');
	});

	it('gives every allowed type the extension its file is stored under', () => {
		expect(ALLOWED_MIMES.map((mime) => extensionForMime(mime))).toEqual([
			'png',
			'jpg',
			'webp',
			'gif',
			'mp4',
			'webm',
			'mov',
			'mp3',
			'm4a',
			'ogg',
			'wav'
		]);
		// One extension for every file, so nothing a caller declares can pick one.
		expect(extensionForMime('image/svg+xml')).toBe('bin');
		expect(extensionForMime('application/pdf')).toBe('bin');
		expect(extensionForMime('not a mime')).toBeUndefined();
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

/**
 * Sound (migration 038).
 *
 * The owner: "allow agents and users to attach a number of sound files, that can
 * be played directly in the dashboard." Real files, made by ffmpeg, because the
 * whole question here is what the magic bytes say — a hand-written header would
 * be testing this file against itself.
 */
describe('sound the dashboard plays', () => {
	it('recognises each container, in the allowlist’s own spelling', async () => {
		const seen = await Promise.all(
			(['mp3', 'm4a', 'ogg', 'wav'] as const).map(async (container) =>
				sniffMime(await sampleAudioBytes({ container }))
			)
		);

		// An .m4a sniffs as audio/x-m4a and an Opus file as "audio/ogg; codecs=opus";
		// both come back as the type the allowlist names.
		expect(seen).toEqual(['audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav']);
	});

	it('gives every sound the kind that gets played rather than downloaded', () => {
		for (const mime of AUDIO_MIMES) {
			expect(kindForMime(mime), mime).toBe('audio');
			expect(isAllowedMime(mime), mime).toBe(true);
		}
	});

	it('still stores the types it cannot play as files', () => {
		// FLAC and AIFF are perfectly real sound; no browser promise to play them,
		// so they download rather than pretending to be a player.
		for (const mime of ['audio/flac', 'audio/aiff', 'audio/x-ms-wma']) {
			expect(kindForMime(mime), mime).toBe('file');
		}
	});

	it('resolves an alias only to something already allowed', () => {
		expect(canonicalMime('AUDIO/X-M4A')).toBe('audio/mp4');
		expect(canonicalMime('audio/ogg; codecs=opus')).toBe('audio/ogg');
		expect(canonicalMime('audio/flac')).toBe('audio/flac');
		expect(isAllowedMime(canonicalMime('audio/flac'))).toBe(false);
	});
});
