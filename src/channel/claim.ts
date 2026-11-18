/**
 * Which of the two bridges is delivering, so a session is not told twice.
 *
 * The owner: "avoid double delivery with the channel. If the session also has
 * the agent-dashboard-channel, everything would arrive twice."
 *
 * Both halves can run in one session — the channel is an MCP server, the
 * monitor is a background command — and neither can see the other's
 * configuration. So the channel leaves a note saying it is alive, and the
 * monitor reads it and stands down.
 *
 * ## Why a file, and why it expires
 *
 * A file because it is the only thing both processes can reach: they are
 * separate processes with different environments, started by different parts of
 * Claude Code. It expires because a channel that was killed must not silence
 * every future monitor — the claim is re-stamped every {@link CLAIM_EVERY_MS}
 * while the channel runs, and is ignored once it is {@link CLAIM_STALE_MS} old.
 *
 * ## Why it is careful about *whose* claim it is
 *
 * The plugin's data directory can be shared by more than one session on a
 * machine. Silencing this session's monitor because *another* session has a
 * channel would be the bug this exists to prevent, wearing a different hat. So
 * a claim carries the session it belongs to when Claude Code says what that is,
 * and is honoured only for that session; with no session id to compare, it
 * falls back to "the process that wrote it is still alive", which is the best
 * available answer and is at least never stale.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The file the channel writes and the monitor reads. */
export const CLAIM_FILE = 'channel.alive';

/** How often the channel re-stamps it. */
export const CLAIM_EVERY_MS = 20_000;

/** How old a claim may be before nobody believes it. */
export const CLAIM_STALE_MS = 90_000;

export type Claim = {
	/** The channel process. Used when there is no session id to compare. */
	pid: number;
	/** The session it belongs to, when Claude Code says what that is. */
	session: string | null;
	/** When it was last stamped. */
	at: number;
};

/** Where the claim lives, or `null` when this process has no plugin directory. */
export function claimPath(env: NodeJS.ProcessEnv): string | null {
	const dir = env.CLAUDE_PLUGIN_DATA?.trim();
	return dir ? join(dir, CLAIM_FILE) : null;
}

/** The session Claude Code says this process belongs to, if it says at all. */
function sessionOf(env: NodeJS.ProcessEnv): string | null {
	const id = env.CLAUDE_SESSION_ID?.trim();
	return id ? id : null;
}

export type ClaimIo = {
	write?: typeof writeFileSync;
	read?: typeof readFileSync;
	mkdir?: typeof mkdirSync;
	alive?: (pid: number) => boolean;
	now?: () => number;
};

/** Is that process still there? `process.kill(pid, 0)` asks without signalling. */
function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Say the channel is delivering for this session.
 *
 * Never throws: a claim that could not be written means the monitor may also
 * deliver, which is a duplicate notification — worth avoiding, not worth
 * failing the channel over.
 */
export function stampClaim(env: NodeJS.ProcessEnv, io: ClaimIo = {}): void {
	const path = claimPath(env);
	if (!path) return;

	const claim: Claim = {
		pid: process.pid,
		session: sessionOf(env),
		at: (io.now ?? Date.now)()
	};

	try {
		(io.mkdir ?? mkdirSync)(env.CLAUDE_PLUGIN_DATA!.trim(), { recursive: true });
		(io.write ?? writeFileSync)(path, JSON.stringify(claim), { mode: 0o600 });
	} catch {
		// See above: a missing claim costs a duplicate, not a delivery.
	}
}

/**
 * Is a channel delivering to *this* session right now?
 *
 * The rule, in order: a claim has to exist, be fresh, and be this session's —
 * by session id when both sides know one, and otherwise by the writing process
 * still being alive.
 */
export function channelIsLive(env: NodeJS.ProcessEnv, io: ClaimIo = {}): boolean {
	const path = claimPath(env);
	if (!path) return false;

	let claim: Claim;
	try {
		const parsed: unknown = JSON.parse(String((io.read ?? readFileSync)(path, 'utf8')));
		if (typeof parsed !== 'object' || parsed === null) return false;
		const { pid, session, at } = parsed as Record<string, unknown>;
		if (typeof pid !== 'number' || typeof at !== 'number') return false;
		claim = { pid, session: typeof session === 'string' ? session : null, at };
	} catch {
		// No claim, half-written, or not JSON. All three mean "nobody is claiming".
		return false;
	}

	if ((io.now ?? Date.now)() - claim.at > CLAIM_STALE_MS) return false;

	const mine = sessionOf(env);
	if (mine && claim.session) return claim.session === mine;

	return (io.alive ?? processAlive)(claim.pid);
}
