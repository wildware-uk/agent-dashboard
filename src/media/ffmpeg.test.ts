import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	POSTER_AT_S,
	isWebPlayable,
	posterSeconds,
	probeVideo,
	runFfmpeg,
	type VideoProbe
} from './ffmpeg';
import { sampleVideoBytes } from './testing';

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'agent-dashboard-ffmpeg-'));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function write(name: string, bytes: Uint8Array): string {
	const file = join(dir, name);
	writeFileSync(file, bytes);
	return file;
}

const probe = (overrides: Partial<VideoProbe> = {}): VideoProbe => ({
	durationMs: 1000,
	width: 320,
	height: 240,
	videoCodec: 'h264',
	audioCodec: null,
	formats: ['mov', 'mp4', 'm4a'],
	...overrides
});

describe('probeVideo', () => {
	it('reads duration, dimensions and codecs off a real one-second mp4', async () => {
		const file = write('one.mp4', await sampleVideoBytes({ seconds: 1 }));

		const read = await probeVideo(file);

		expect(read.durationMs).toBe(1000);
		expect(read.width).toBe(320);
		expect(read.height).toBe(240);
		expect(read.videoCodec).toBe('h264');
		expect(read.audioCodec).toBeNull();
		expect(read.formats).toContain('mp4');
	});

	it('reports the audio codec when there is a track', async () => {
		const file = write('sound.mp4', await sampleVideoBytes({ seconds: 1, audio: true }));

		expect((await probeVideo(file)).audioCodec).toBe('aac');
	});

	it('throws with the tool name and its complaint for bytes that are not video', async () => {
		const file = write('broken.mp4', new TextEncoder().encode('not a video at all'));

		await expect(probeVideo(file)).rejects.toThrow(/ffprobe/i);
	});
});

describe('runFfmpeg', () => {
	it('surfaces a non-zero exit as an error naming ffmpeg', async () => {
		await expect(
			runFfmpeg(['-i', join(dir, 'nothing-here.mp4'), join(dir, 'out.jpg')])
		).rejects.toThrow(/ffmpeg/i);
	});
});

describe('posterSeconds', () => {
	it('takes the frame at one second, as the design says', () => {
		expect(POSTER_AT_S).toBe(1);
		expect(posterSeconds(5_000)).toBe(1);
		expect(posterSeconds(null)).toBe(1);
	});

	it('moves inside a video too short to have a frame at one second', () => {
		// ffmpeg exits 0 and writes nothing when the seek lands past the last
		// frame, so a one-second fixture would silently produce no poster.
		expect(posterSeconds(1_000)).toBeLessThan(1);
		expect(posterSeconds(1_000)).toBeGreaterThan(0);
		expect(posterSeconds(200)).toBeGreaterThanOrEqual(0);
	});
});

describe('isWebPlayable', () => {
	it('accepts h264 in mp4, with or without aac', () => {
		expect(isWebPlayable('video/mp4', probe())).toBe(true);
		expect(isWebPlayable('video/mp4', probe({ audioCodec: 'aac' }))).toBe(true);
		expect(isWebPlayable('video/mp4', probe({ audioCodec: 'mp3' }))).toBe(true);
	});

	it('accepts the webm codecs every current browser plays', () => {
		expect(isWebPlayable('video/webm', probe({ videoCodec: 'vp9', audioCodec: 'opus' }))).toBe(
			true
		);
		expect(isWebPlayable('video/webm', probe({ videoCodec: 'vp8', audioCodec: 'vorbis' }))).toBe(
			true
		);
	});

	it('rejects a codec the browser cannot decode', () => {
		expect(isWebPlayable('video/mp4', probe({ videoCodec: 'mpeg4' }))).toBe(false);
		expect(isWebPlayable('video/mp4', probe({ audioCodec: 'ac3' }))).toBe(false);
		expect(isWebPlayable('video/webm', probe({ videoCodec: 'h264' }))).toBe(false);
	});

	it('rejects quicktime whatever is inside it, because a .mov is not a web format', () => {
		expect(isWebPlayable('video/quicktime', probe())).toBe(false);
	});

	it('rejects a file with no video stream at all', () => {
		expect(isWebPlayable('video/mp4', probe({ videoCodec: null }))).toBe(false);
	});
});
