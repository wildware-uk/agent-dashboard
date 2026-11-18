/**
 * What is noted on a card, as the page reads it (migration 040).
 *
 * The owner: "allow agents to set metadata on cards, for example, branch name,
 * PR link, anything they like."
 */
import type { CardFieldView } from './types';

/**
 * The fields on one card, in the order they were first set.
 *
 * Oldest first rather than alphabetical: the order somebody wrote them in is
 * usually the order they happened in — branch, then pull request, then
 * environment — and re-sorting that into `b, e, p` throws the story away.
 */
export function fieldsOn(
	card: { kind: string; id: string },
	fields: readonly CardFieldView[]
): CardFieldView[] {
	return fields.filter((field) => field.card.kind === card.kind && field.card.id === card.id);
}

/**
 * The link a value is, or `null` when it is not one.
 *
 * `http` and `https` only. The value was written by an agent, so it is
 * untrusted text (design §8) — and a `javascript:` URL rendered as a link would
 * be script execution on this origin, handed over by whoever clicked it. Parsed
 * rather than pattern-matched, because "starts with http" also accepts
 * `httpevil:` and misses nothing that matters.
 */
export function linkOf(value: string): string | null {
	const text = value.trim();
	if (!text.startsWith('http://') && !text.startsWith('https://')) return null;
	try {
		const url = new URL(text);
		return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
	} catch {
		return null;
	}
}
