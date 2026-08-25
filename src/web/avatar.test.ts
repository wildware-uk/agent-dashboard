import { describe, expect, it } from 'vitest';
import { avatarFor } from './avatar';

describe('name-hashed avatars', () => {
	it('gives the same name the same colour every time', () => {
		expect(avatarFor('claude-code').hue).toBe(avatarFor('claude-code').hue);
	});

	it('gives different names different colours', () => {
		const hues = new Set(
			['claude-code', 'codex', 'aider', 'cursor', 'devin'].map((name) => avatarFor(name).hue)
		);

		// Five names, five buckets: a hash that collided on this handful would be
		// making the timeline harder to scan, not easier.
		expect(hues.size).toBe(5);
	});

	it('stays inside the colour wheel', () => {
		for (const name of ['a', 'zzzzzzzz', 'Agent 7', '01JBQ8Z0000000000000000000']) {
			const { hue } = avatarFor(name);

			expect(hue).toBeGreaterThanOrEqual(0);
			expect(hue).toBeLessThan(360);
		}
	});

	it('ignores case and surrounding space, so one agent is one colour', () => {
		expect(avatarFor(' Claude-Code ')).toEqual(avatarFor('claude-code'));
	});

	it('initials a multi-word name from its words', () => {
		expect(avatarFor('release bot').initials).toBe('RB');
		expect(avatarFor('agent-smith').initials).toBe('AS');
	});

	it('initials a single word from its first two letters', () => {
		expect(avatarFor('codex').initials).toBe('CO');
	});

	it('never renders an empty badge', () => {
		expect(avatarFor('').initials).toBe('?');
		expect(avatarFor('   ').initials).toBe('?');
	});
});
