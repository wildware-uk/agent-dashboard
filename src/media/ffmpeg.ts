/**
 * The two system binaries the video half of the pipeline is (design §6, §10).
 *
 * `ffmpeg` is a *system* dependency, not an npm one: the Dockerfile installs it
 * (§10) and CI installs it (§9). Wrapping it here rather than calling it from
 * `./derive.ts` buys three things worth the file.
 *
 * - **Nothing an agent sends becomes an argument.** `execFile`, never a shell,
 *   and every path handed to it is one `./paths.ts` built out of a ULID this
 *   server minted. There is no string interpolation into a command line
 *   anywhere in this module, so there is nothing to escape.
 * - **Every run is bounded.** A malformed file can make a decoder spin; a
 *   timeout means the worst case is one failed media item rather than a wedged
 *   job holding one of the two slots for ever.
 * - **A failure says what failed.** ffmpeg's diagnosis lives in the last lines
 *   of stderr, so those are what the error message carries — that string is what
 *   ends up recorded as the reason the media is `failed`.
 *
 * {@link isWebPlayable} is the other half of §6 step 4: "an h264 mp4 transcode
 * when the source is not web-playable". What counts as web-playable is a
 * judgement, so it is one function with a truth table in its test rather than a
 * condition buried in the transcode branch.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Looked up on `PATH`. The Docker image installs it (design §10). */
export const FFMPEG = 'ffmpeg';
export const FFPROBE = 'ffprobe';

/** Reading a header should be instant; this is only here so it cannot hang. */
export const PROBE_TIMEOUT_MS = 30_000;

/**
 * A transcode's budget.
 *
 * Generous because it is bounded work on a bounded input — the upload cap is
 * `MAX_VIDEO_BYTES` — and because the alternative to a slow transcode finishing
 * is a video the owner cannot play at all.
 */
export const FFMPEG_TIMEOUT_MS = 15 * 60_000;

/** Where the poster frame comes from (design §6 step 4). */
export const POSTER_AT_S = 1;

/** Enough of ffprobe's answer to make every decision this pipeline makes. */
export type VideoProbe = {
	/** Rounded to whole milliseconds, which is what `media.duration_ms` stores. */
	durationMs: number | null;
	width: number | null;
	height: number | null;
	/** `null` when the file has no video stream — an audio-only mp4, say. */
	videoCodec: string | null;
	/** `null` when the file is silent. Not a problem, just a fact. */
	audioCodec: string | null;
	/** The container names ffprobe recognised, e.g. `['mov', 'mp4', 'm4a']`. */
	formats: string[];
};

export type ToolOptions = {
	/** Overridable so a test can point at a stub. Defaults to `PATH`. */
	binary?: string;
	timeoutMs?: number;
};

/** ffprobe's `-print_format json` output, as much of it as is read. */
type ProbeJson = {
	format?: { duration?: string; format_name?: string };
	streams?: Array<{
		codec_type?: string;
		codec_name?: string;
		width?: number;
		height?: number;
		duration?: string;
	}>;
};

/**
 * Ask ffprobe what a file is.
 *
 * @throws `Error` naming ffprobe and quoting its stderr — which is what a
 *   corrupt file produces, and what gets recorded as the failure reason.
 */
export async function probeVideo(file: string, options: ToolOptions = {}): Promise<VideoProbe> {
	const stdout = await run(
		options.binary ?? FFPROBE,
		['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
		options.timeoutMs ?? PROBE_TIMEOUT_MS
	);

	let parsed: ProbeJson;
	try {
		parsed = JSON.parse(stdout) as ProbeJson;
	} catch (cause) {
		throw new Error(`ffprobe returned output that is not JSON`, { cause });
	}

	const streams = parsed.streams ?? [];
	const video = streams.find((stream) => stream.codec_type === 'video');
	const audio = streams.find((stream) => stream.codec_type === 'audio');

	if (!parsed.format && streams.length === 0) {
		throw new Error('ffprobe found no streams and no container in this file');
	}

	return {
		durationMs: seconds(parsed.format?.duration) ?? seconds(video?.duration) ?? null,
		width: video?.width ?? null,
		height: video?.height ?? null,
		videoCodec: video?.codec_name ?? null,
		audioCodec: audio?.codec_name ?? null,
		formats: (parsed.format?.format_name ?? '').split(',').filter(Boolean)
	};
}

/** `"1.000000"` -> `1000`. Anything unparseable is `undefined`, never `NaN`. */
function seconds(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number.parseFloat(value);
	return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 1000) : undefined;
}

/**
 * Run ffmpeg.
 *
 * @returns its stderr, which is where ffmpeg writes everything.
 * @throws `Error` naming ffmpeg and quoting the tail of that stderr.
 */
export async function runFfmpeg(
	args: readonly string[],
	options: ToolOptions = {}
): Promise<string> {
	// `-nostdin` matters: ffmpeg reads stdin for interactive keys, and inheriting
	// a server's stdin would let it consume bytes meant for somebody else.
	const { stderr } = await spawn(
		options.binary ?? FFMPEG,
		['-hide_banner', '-nostdin', '-loglevel', 'error', ...args],
		options.timeoutMs ?? FFMPEG_TIMEOUT_MS
	);
	return stderr;
}

async function run(binary: string, args: readonly string[], timeoutMs: number): Promise<string> {
	return (await spawn(binary, args, timeoutMs)).stdout;
}

async function spawn(
	binary: string,
	args: readonly string[],
	timeoutMs: number
): Promise<{ stdout: string; stderr: string }> {
	try {
		const { stdout, stderr } = await execFileAsync(binary, [...args], {
			timeout: timeoutMs,
			// A transcode's log is small; a probe's JSON on a many-stream file is not
			// large either. This is a bound, not a budget.
			maxBuffer: 8 * 1024 * 1024,
			windowsHide: true
		});
		return { stdout: stdout.toString(), stderr: stderr.toString() };
	} catch (cause) {
		throw new Error(`${binary} failed: ${complaint(cause)}`, { cause });
	}
}

/**
 * The useful part of a failed run.
 *
 * ffmpeg's real diagnosis is the last few lines of stderr; everything above it
 * is a description of the build. A missing binary has no stderr at all, so the
 * spawn error's own message stands in — which is how "ffmpeg is not installed"
 * reads as itself rather than as an empty failure.
 */
function complaint(error: unknown): string {
	const detail = error as { stderr?: unknown; message?: string; code?: unknown };
	const stderr = typeof detail?.stderr === 'string' ? detail.stderr.trim() : '';
	const tail = stderr.split('\n').slice(-4).join('; ').trim();
	if (tail) return tail;
	if (detail?.code === 'ENOENT') return `${detail.message ?? 'not found'} (is it installed?)`;
	return detail?.message ?? 'no output';
}

/** Codecs a current browser plays in each container. */
const PLAYABLE = {
	'video/mp4': { video: ['h264'], audio: ['aac', 'mp3'] },
	'video/webm': { video: ['vp8', 'vp9', 'av1'], audio: ['opus', 'vorbis'] }
} as const satisfies Record<string, { video: readonly string[]; audio: readonly string[] }>;

/**
 * Can a browser play these bytes as they are (design §6 step 4)?
 *
 * Deliberately narrow. `video/quicktime` is never playable however h264 its
 * contents are — a `.mov` is a Mac screen recording, and Safari playing it is
 * not "the browser" — and a container whose codecs we cannot name is treated as
 * unplayable. Being wrong towards `false` costs one transcode; being wrong
 * towards `true` is a video that silently does not play for the owner.
 */
export function isWebPlayable(mime: string, probe: VideoProbe): boolean {
	const allowed = (
		PLAYABLE as Record<string, { video: readonly string[]; audio: readonly string[] }>
	)[mime];
	if (!allowed) return false;
	if (!probe.videoCodec || !allowed.video.includes(probe.videoCodec)) return false;
	return probe.audioCodec === null || allowed.audio.includes(probe.audioCodec);
}

/**
 * Where to seek for the poster frame.
 *
 * The design says one second, and one second is what a video of any real length
 * gets. The clamp exists because ffmpeg treats a seek past the last frame as
 * success and writes nothing at all: on the design's own one-second fixture,
 * `-ss 1` produces an empty directory and a zero exit status. So anything not
 * comfortably longer than a second is sampled at its midpoint instead.
 */
export function posterSeconds(durationMs: number | null): number {
	if (durationMs === null || durationMs > 1200) return POSTER_AT_S;
	return Math.max(0, Math.round((durationMs / 2000) * 1000) / 1000);
}
