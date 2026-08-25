import { describe, expect, it } from 'vitest';
import { agentLabel, avatarFor } from './avatar';

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

describe('what to call the poster of an update', () => {
	it('uses the display name the timeline resolved', () => {
		expect(agentLabel('01M0X5XHT67FCP294SSA3B2XHV', 'build-bot')).toBe('build-bot');
	});

	it('trims a name, so a stray space is not a second agent', () => {
		expect(agentLabel('a1', '  docs-writer ')).toBe('docs-writer');
	});

	it('shortens an id nobody has a name for, rather than printing 26 characters', () => {
		const label = agentLabel('01M0X5XHT67FCP294SSA3B2XHV');

		expect(label).toBe('agent-3b2xhv');
		expect(label.length).toBeLessThan(15);
	});

	it('badges an unknown agent as something other than "01"', () => {
		// The bug this exists for: every ULID begins `01` until 2039, so taking the
		// first two characters of an id made every avatar in the timeline read the
		// same (#20).
		expect(avatarFor(agentLabel('01M0X5XHT67FCP294SSA3B2XHV')).initials).not.toBe('01');
	});

	it('keeps two unknown agents distinguishable', () => {
		const one = agentLabel('01M0X5XHT67FCP294SSA3B2XHV');
		const two = agentLabel('01M0X5XHT67FCP294SSAKQ9WFP');

		expect(one).not.toBe(two);
		expect(avatarFor(one).hue).not.toBe(avatarFor(two).hue);
	});

	it('leaves an id that is already readable alone', () => {
		// Nothing this app mints is this short, so a short id came from a human or
		// a fixture — and shortening it further would lose the only thing it says.
		expect(agentLabel('claude-code')).toBe('claude-code');
	});

	it('always has something to render, even with nothing to go on', () => {
		expect(agentLabel('', '   ')).toBe('unknown agent');
		expect(avatarFor(agentLabel('')).initials).toBe('UA');
	});

	it('prefers the name even for an id short enough to show', () => {
		expect(agentLabel('claude-code', 'Claude Code')).toBe('Claude Code');
	});
});
