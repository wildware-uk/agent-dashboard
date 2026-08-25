/**
 * Test support for the media pipeline (design §9).
 *
 * Two things every media test needs, and neither belongs in a production path:
 *
 * - **Real bytes.** The design's media tests are "a fixture png and a one-second
 *   mp4", plus the hostile cases: a zip renamed `.png`, an SVG. These are the
 *   smallest byte strings that a magic-byte sniffer genuinely identifies, built
 *   in code rather than committed as binaries, so a reader can see exactly what
 *   makes each one that format.
 * - **A place to write.** {@link tempSettings} points the whole module at a
 *   throwaway directory with a known secret and cap, so no test reads the
 *   environment or touches a real data directory.
 *
 * This is a second, test-only entry point of `$media`; import it as
 * `$media/testing`. It is deliberately not re-exported from `./index.ts`.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import type { MediaSettings } from './settings';

const execFileAsync = promisify(execFile);

const decode = (base64: string) => new Uint8Array(Buffer.from(base64, 'base64'));

/** A 4x4 red png, 94 bytes, produced once by `sharp` and pasted here. */
export function pngBytes(): Uint8Array {
	return decode(
		'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEElE' +
			'QVQImWM4YGAARwzEcQDdQxIBbJSv0wAAAABJRU5ErkJggg=='
	);
}

/** The same image as a jpeg. */
export function jpegBytes(): Uint8Array {
	return decode(
		'/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSop' +
			'GR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgo' +
			'KCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAEAAQDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAA' +
			'AAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABQf/xAAUEQEAAAAAAAAA' +
			'AAAAAAAAAAAA/9oADAMBAAIRAxEAPwCOACKk/9k='
	);
}

/** The same image as a webp. */
export function webpBytes(): Uint8Array {
	return decode(
		'UklGRjgAAABXRUJQVlA4ICwAAACQAQCdASoEAAQAAUAmJaACdLoAA5gA/vAb3/W17bwyg/+0s/+tD/9a' + 'H/LgAA=='
	);
}

/** The same image as a gif. */
export function gifBytes(): Uint8Array {
	return decode('R0lGODlhBAAEAIAAAExpccAwMCH5BAUAAAAALAAAAAAEAAQAAAIEjI8ZBQA7');
}

/** An ISO base media file box: four bytes of length, four of type, then payload. */
function box(type: string, payload: Uint8Array): Uint8Array {
	const out = new Uint8Array(8 + payload.length);
	new DataView(out.buffer).setUint32(0, out.length);
	out.set(new TextEncoder().encode(type), 4);
	out.set(payload, 8);
	return out;
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

/** `ftyp` plus an empty `mdat`: the header a sniffer reads, and nothing else. */
function isoFile(brand: string, compatible: readonly string[]): Uint8Array {
	const encoder = new TextEncoder();
	return concat(
		box(
			'ftyp',
			concat(
				encoder.encode(brand),
				new Uint8Array([0, 0, 2, 0]),
				encoder.encode(compatible.join(''))
			)
		),
		box('mdat', new Uint8Array(64))
	);
}

/** An mp4 header. Stands in for the design's one-second fixture: sniffing is all this proves. */
export function mp4Bytes(): Uint8Array {
	return isoFile('isom', ['isom', 'iso2', 'avc1', 'mp41']);
}

/** A QuickTime header — what a Mac screen recording arrives as. */
export function movBytes(): Uint8Array {
	return isoFile('qt  ', ['qt  ']);
}

/** An EBML header whose DocType is `webm`. */
export function webmBytes(): Uint8Array {
	return new Uint8Array([
		0x1a, 0x45, 0xdf, 0xa3, 0xa3, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01, 0x42, 0xf2, 0x81,
		0x04, 0x42, 0xf3, 0x81, 0x08, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d, 0x42, 0x87, 0x81, 0x02,
		0x42, 0x85, 0x81, 0x02
	]);
}

/**
 * A zip. Renamed to `.png` and declared as one, this is the acceptance test the
 * design and issue #13 both single out.
 */
export function zipBytes(): Uint8Array {
	return concat(
		new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
		new Uint8Array(26),
		new TextEncoder().encode('payload.txt'),
		new TextEncoder().encode('not an image')
	);
}

/** An SVG with a script in it: exactly the thing the allowlist exists to keep out. */
export function svgBytes(): Uint8Array {
	return new TextEncoder().encode(
		'<?xml version="1.0" encoding="UTF-8"?>\n' +
			'<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4">' +
			'<script>fetch("/api/snapshot").then((r) => r.text())</script>' +
			'</svg>\n'
	);
}

/**
 * Real header bytes followed by filler, to a total length.
 *
 * The point is an upload that sniffs *correct* and is still too big, so a size
 * rejection cannot be mistaken for a type rejection.
 */
export function paddedBytes(head: Uint8Array, total: number): Uint8Array {
	const out = new Uint8Array(total);
	out.set(head.subarray(0, Math.min(head.length, total)));
	return out;
}

/** Cut a buffer into fixed-size chunks, as an HTTP body arrives. */
export function chunksOf(bytes: Uint8Array, size: number): Uint8Array[] {
	const chunks: Uint8Array[] = [];
	for (let at = 0; at < bytes.length; at += size) chunks.push(bytes.subarray(at, at + size));
	return chunks;
}

/**
 * A body that reports how much of it was actually pulled.
 *
 * This is how "the cap is enforced while writing" is proved rather than
 * asserted: if ingest had buffered the whole request before checking, `pulled`
 * would equal the whole body.
 */
export type CountingBody = {
	stream: ReadableStream<Uint8Array>;
	/** Bytes the consumer has taken so far. */
	pulled: () => number;
	/** Whether the consumer stopped early. */
	cancelled: () => boolean;
};

export function countingBody(bytes: Uint8Array, chunkSize = 256): CountingBody {
	const chunks = chunksOf(bytes, chunkSize);
	let pulled = 0;
	let cancelled = false;
	let next = 0;

	const stream = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				if (next >= chunks.length) {
					controller.close();
					return;
				}
				const chunk = chunks[next++];
				pulled += chunk.length;
				controller.enqueue(chunk);
			},
			cancel() {
				cancelled = true;
			}
		},
		// No buffering ahead of the reader: a chunk is produced only when it is
		// asked for, so `pulled` is what the consumer actually took off the wire
		// rather than what a queue helpfully prefetched.
		{ highWaterMark: 0 }
	);

	return { stream, pulled: () => pulled, cancelled: () => cancelled };
}

/** A `ReadableStream` over bytes already in hand. */
export function bodyOf(bytes: Uint8Array, chunkSize = 64 * 1024): ReadableStream<Uint8Array> {
	return countingBody(bytes, chunkSize).stream;
}

/** The known-good secret test tokens are signed with. Never a real one. */
export const TEST_TOKEN_SECRET = 'test-token-secret-that-is-long-enough-32';

export type TempMedia = {
	settings: MediaSettings;
	/** Remove the directory. Safe to call twice. */
	cleanup: () => void;
};

/**
 * Settings pointing at a throwaway directory.
 *
 * Every media test takes one of these instead of reading the environment, so a
 * test can never write into a real `DATA_DIR` and two tests can never share a
 * disk layout.
 */
export function tempSettings(overrides: Partial<MediaSettings> = {}): TempMedia {
	const dataDir = mkdtempSync(join(tmpdir(), 'agent-dashboard-media-'));

	return {
		settings: {
			dataDir,
			tokenSecret: TEST_TOKEN_SECRET,
			baseUrl: 'https://agents.example.test',
			maxImageBytes: 64 * 1024,
			maxVideoBytes: 256 * 1024,
			...overrides
		},
		cleanup: () => rmSync(dataDir, { recursive: true, force: true })
	};
}

/**
 * A real image with real EXIF in it, for proving the thumbnailer strips it.
 *
 * The byte fixtures above are hand-built headers, which is all a sniffer needs;
 * a thumbnail test needs pixels, a size worth reducing, and metadata that is
 * genuinely there — so this one is generated by `sharp` at test time. `Copyright`
 * and `Software` are the tags chosen because they survive in a
 * metadata-preserving encoder, so an assertion that they are gone means the
 * stripping is real rather than incidental.
 */
export async function exifImageBytes(
	options: { format?: 'png' | 'jpeg'; width?: number; height?: number } = {}
): Promise<Uint8Array> {
	const { format = 'png', width = 1800, height = 900 } = options;
	const image = sharp({
		create: { width, height, channels: 3, background: '#204080' }
	}).withExif({ IFD0: { Copyright: 'Wildware', Software: 'agent-dashboard fixture' } });

	const buffer = await (format === 'png' ? image.png() : image.jpeg()).toBuffer();
	return new Uint8Array(buffer);
}

/** Does this buffer still carry an EXIF block? Both container spellings. */
export function hasExifBlock(bytes: Uint8Array): boolean {
	const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return buffer.includes('Exif') || buffer.includes('eXIf');
}

export type SampleVideo = {
	/** Exact length, so a duration assertion can be exact. */
	seconds?: number;
	width?: number;
	height?: number;
	/** `h264` is web-playable; `mpeg4` is the case that has to be transcoded. */
	codec?: 'h264' | 'mpeg4';
	/** `mp4`, or `mov` for what a Mac screen recording arrives as. */
	container?: 'mp4' | 'mov';
	/** Include a silent audio track, so a transcode has audio to carry over. */
	audio?: boolean;
};

/**
 * A real video, generated by the system `ffmpeg`.
 *
 * The design's media tests are "a fixture png and a one-second mp4" (§9), and CI
 * installs ffmpeg for exactly this. Generating it beats committing a binary:
 * every test can name the duration, size and codec it needs, and the
 * "not web-playable" case is one argument away rather than a second blob.
 */
export async function sampleVideoBytes(options: SampleVideo = {}): Promise<Uint8Array> {
	const {
		seconds = 1,
		width = 320,
		height = 240,
		codec = 'h264',
		container = 'mp4',
		audio = false
	} = options;

	const dir = mkdtempSync(join(tmpdir(), 'agent-dashboard-fixture-'));
	const file = join(dir, `sample.${container}`);

	try {
		await execFileAsync('ffmpeg', [
			'-hide_banner',
			'-loglevel',
			'error',
			'-y',
			'-f',
			'lavfi',
			'-i',
			`testsrc=duration=${seconds}:size=${width}x${height}:rate=25`,
			...(audio ? ['-f', 'lavfi', '-i', `anullsrc=r=44100:cl=stereo`, '-shortest'] : []),
			'-c:v',
			codec === 'h264' ? 'libx264' : 'mpeg4',
			'-pix_fmt',
			'yuv420p',
			...(audio ? ['-c:a', 'aac'] : []),
			file
		]);

		return new Uint8Array(readFileSync(file));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
