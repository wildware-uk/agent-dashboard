import { describe, expect, it } from 'vitest';
import { LEVELS, levelStyle } from './levels';

describe('level colours', () => {
	it('gives each of the four levels its own colour', () => {
		const bars = new Set(Object.values(LEVELS).map((style) => style.bar));

		expect(bars.size).toBe(4);
	});

	it('names each level, so the colour is not the only signal', () => {
		expect(Object.values(LEVELS).map((style) => style.label)).toEqual([
			'Info',
			'Success',
			'Warning',
			'Error'
		]);
	});

	it('falls back to info for a level it does not know', () => {
		// The rows come from an agent's tool call. The domain validates them, but a
		// card that renders nothing because of one unexpected string would be a
		// worse failure than a card that renders in the neutral colour.
		expect(levelStyle('catastrophe' as never)).toBe(LEVELS.info);
	});
});
