import { describe, expect, it, vi } from 'vitest';
import { CLAIM_FILE, CLAIM_STALE_MS, channelIsLive, claimPath, stampClaim } from './index';

/**
 * Which of the two bridges is delivering (plugin 0.2.0).
 *
 * The owner: "avoid double delivery with the channel. If the session also has
 * the agent-dashboard-channel, everything would arrive twice."
 */
const NOW = Date.UTC(2026, 8, 25, 12);

function io(overrides: Record<string, unknown> = {}) {
	return {
		now: () => NOW,
		mkdir: vi.fn(),
		write: vi.fn(),
		alive: () => true,
		...overrides
	} as never;
}

const claimOf = (claim: Record<string, unknown>) => () => JSON.stringify(claim);

describe('stamping a claim', () => {
	it('writes the pid, the session and the time, readable by nobody else', () => {
		const write = vi.fn();

		stampClaim({ CLAUDE_PLUGIN_DATA: '/data', CLAUDE_SESSION_ID: 's1' }, io({ write }));

		const [path, body, options] = write.mock.calls[0] as [string, string, { mode: number }];
		expect(path).toContain(CLAIM_FILE);
		expect(JSON.parse(body)).toMatchObject({ pid: process.pid, session: 's1', at: NOW });
		// It says which agent token is in use by implication, and it sits beside a
		// file that holds one, so it is nobody else's business.
		expect(options.mode).toBe(0o600);
	});

	it('does nothing at all without a plugin directory, and never throws', () => {
		const write = vi.fn();

		stampClaim({}, io({ write }));
		expect(write).not.toHaveBeenCalled();
		expect(claimPath({})).toBeNull();

		// A claim that cannot be written costs a duplicate notification, not the
		// channel: the failure is swallowed on purpose.
		expect(() =>
			stampClaim(
				{ CLAUDE_PLUGIN_DATA: '/data' },
				io({
					write: () => {
						throw new Error('read-only');
					}
				})
			)
		).not.toThrow();
	});
});

describe('standing aside for a live channel', () => {
	it('believes a fresh claim from this session', () => {
		const live = channelIsLive(
			{ CLAUDE_PLUGIN_DATA: '/data', CLAUDE_SESSION_ID: 's1' },
			io({ read: claimOf({ pid: 1, session: 's1', at: NOW - 1_000 }) })
		);

		expect(live).toBe(true);
	});

	it('ignores another session’s claim, which is the bug this would otherwise be', () => {
		// The plugin's data directory can be shared by two sessions on a machine.
		// Silencing this session because a different one has a channel would be
		// the same missed notification in a different hat.
		const live = channelIsLive(
			{ CLAUDE_PLUGIN_DATA: '/data', CLAUDE_SESSION_ID: 's2' },
			io({ read: claimOf({ pid: 1, session: 's1', at: NOW }) })
		);

		expect(live).toBe(false);
	});

	it('ignores a claim nobody has renewed', () => {
		const live = channelIsLive(
			{ CLAUDE_PLUGIN_DATA: '/data', CLAUDE_SESSION_ID: 's1' },
			io({ read: claimOf({ pid: 1, session: 's1', at: NOW - CLAIM_STALE_MS - 1 }) })
		);

		expect(live).toBe(false);
	});

	it('falls back to "is that process still there" when there is no session id', () => {
		const read = claimOf({ pid: 4242, session: null, at: NOW });

		expect(channelIsLive({ CLAUDE_PLUGIN_DATA: '/data' }, io({ read, alive: () => true }))).toBe(
			true
		);
		expect(channelIsLive({ CLAUDE_PLUGIN_DATA: '/data' }, io({ read, alive: () => false }))).toBe(
			false
		);
	});

	it('says no when there is no claim, no directory, or nonsense in the file', () => {
		expect(channelIsLive({}, io())).toBe(false);
		expect(
			channelIsLive(
				{ CLAUDE_PLUGIN_DATA: '/data' },
				io({
					read: () => {
						throw new Error('ENOENT');
					}
				})
			)
		).toBe(false);
		expect(channelIsLive({ CLAUDE_PLUGIN_DATA: '/data' }, io({ read: () => '{"pid":' }))).toBe(
			false
		);
		expect(
			channelIsLive({ CLAUDE_PLUGIN_DATA: '/data' }, io({ read: claimOf({ pid: 'one' }) }))
		).toBe(false);
	});
});
