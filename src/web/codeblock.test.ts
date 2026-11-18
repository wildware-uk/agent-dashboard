import { describe, expect, it } from 'vitest';
import { UNKNOWN_LABEL, labelFor } from './codeblock';

/**
 * What a code block's header says (design §7).
 *
 * The owner asked for "a small header which says which language it is". The
 * interesting case is the third one: an agent that named a language we have no
 * grammar for still said something, and replacing its word with "Code" would
 * throw away the only thing anybody knew.
 */
const DISPLAY: Record<string, string> = { ts: 'TypeScript', kotlin: 'Kotlin', sql: 'SQL' };
const display = (name: string) => DISPLAY[name];

describe('naming a block', () => {
	it('uses the grammar`s own name, not the fence`s shorthand', () => {
		expect(labelFor('ts', display)).toBe('TypeScript');
		expect(labelFor('kotlin', display)).toBe('Kotlin');
	});

	it('states a declared language however odd, because the author said it', () => {
		expect(labelFor('pseudocode', display)).toBe('pseudocode');
	});

	it('says nothing about a bare fence, because nobody said', () => {
		// A guess still colours the block, but naming one is a claim — and on the
		// real dashboard the first two guesses this header made were a tool
		// signature labelled "Packet Filter config" and an XML tag labelled
		// "PostgreSQL". Both were bare fences holding no code at all.
		expect(labelFor(null, display)).toBe(UNKNOWN_LABEL);
	});
});
