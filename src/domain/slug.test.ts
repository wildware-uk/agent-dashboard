import { describe, expect, it } from 'vitest';
import { SLUG_MAX_LENGTH, assertSlug, isSlug, slugFor, slugify } from './slug';
import { DomainError } from './errors';

describe('slugify', () => {
	it('lowercases and hyphenates a human name', () => {
		expect(slugify('Agent Dashboard')).toBe('agent-dashboard');
	});

	it('collapses runs of punctuation and trims the edges', () => {
		expect(slugify('  --Hello,   World!! ')).toBe('hello-world');
	});

	it('folds accents rather than dropping the letter', () => {
		expect(slugify('Café Déjà Vu')).toBe('cafe-deja-vu');
	});

	it('keeps digits', () => {
		expect(slugify('v0.1 status wall')).toBe('v0-1-status-wall');
	});

	it('truncates to the maximum length without leaving a trailing hyphen', () => {
		const slug = slugify(`${'a'.repeat(SLUG_MAX_LENGTH)} tail`);

		expect(slug).toBe('a'.repeat(SLUG_MAX_LENGTH));
	});

	it('trims a hyphen left exactly on the truncation boundary', () => {
		const slug = slugify(`${'a'.repeat(SLUG_MAX_LENGTH - 1)} tail`);

		expect(slug).toBe('a'.repeat(SLUG_MAX_LENGTH - 1));
	});

	it('yields the empty string when nothing survives', () => {
		expect(slugify('!!!')).toBe('');
		expect(slugify('')).toBe('');
	});
});

describe('isSlug', () => {
	it('accepts lowercase words joined by single hyphens', () => {
		expect(isSlug('dashboard')).toBe(true);
		expect(isSlug('agent-dashboard-2')).toBe(true);
	});

	it('rejects anything an agent could not paste into a URL unchanged', () => {
		for (const bad of ['', 'Dashboard', 'agent dashboard', '-lead', 'trail-', 'a--b', 'a_b', 'é']) {
			expect(isSlug(bad), bad).toBe(false);
		}
	});

	it('rejects a slug longer than the maximum', () => {
		expect(isSlug('a'.repeat(SLUG_MAX_LENGTH))).toBe(true);
		expect(isSlug('a'.repeat(SLUG_MAX_LENGTH + 1))).toBe(false);
	});
});

describe('assertSlug', () => {
	it('normalises case and surrounding whitespace', () => {
		expect(assertSlug(' Dashboard ')).toBe('dashboard');
	});

	it('rejects a slug it cannot normalise, naming the expected shape', () => {
		expect(() => assertSlug('my project')).toThrow(DomainError);
		expect(() => assertSlug('my project')).toThrow(/lowercase/);
	});

	it('carries the invalid_argument code so an adapter can map it', () => {
		expect(() => assertSlug('')).toThrowError(
			expect.objectContaining({ code: 'invalid_argument' })
		);
	});
});

describe('slugFor', () => {
	it('derives a slug from the name when none is given', () => {
		expect(slugFor('Agent Dashboard')).toBe('agent-dashboard');
	});

	it('prefers an explicit slug, normalised', () => {
		expect(slugFor('Agent Dashboard', 'Feed')).toBe('feed');
	});

	it('refuses a name no slug can be derived from, rather than inventing one', () => {
		expect(() => slugFor('!!!')).toThrow(/slug/);
	});
});
