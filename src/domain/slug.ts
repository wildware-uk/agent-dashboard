/**
 * Project slugs: the handle an agent types.
 *
 * A slug is the one identifier a human puts in a URL and an agent hard-codes in
 * its prompt, so it is deliberately narrow: lowercase letters, digits, and
 * single hyphens. `createProject` is idempotent on it (design §5), which only
 * holds if the same name always produces the same slug — hence one generator
 * here rather than a `toLowerCase()` at each call site.
 */
import { invalid } from './errors';

/** Long enough for a real project name, short enough to stay readable in a URL. */
export const SLUG_MAX_LENGTH = 64;

/** Lowercase alphanumeric words joined by single hyphens. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Derive a slug from arbitrary text, or `''` when nothing usable survives.
 *
 * Accents are folded rather than dropped (`Café` becomes `cafe`, not `caf`) so a
 * non-English project name still produces a slug its owner recognises.
 */
export function slugify(value: string): string {
	const folded = value
		.normalize('NFKD')
		// Combining marks left behind by NFKD: fold, don't hyphenate.
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-');

	return trimHyphens(trimHyphens(folded).slice(0, SLUG_MAX_LENGTH));
}

/** Whether a string is already a slug, exactly as stored. */
export function isSlug(value: string): boolean {
	return value.length <= SLUG_MAX_LENGTH && SLUG_PATTERN.test(value);
}

/**
 * Normalise a slug the caller supplied, or refuse it.
 *
 * Case and surrounding whitespace are forgiven, because those are typing
 * accidents. Anything else is not silently rewritten: an agent that asked for
 * `my project` and got `my-project` would go on to use the wrong handle.
 */
export function assertSlug(value: string): string {
	const normalised = value.trim().toLowerCase();
	if (!isSlug(normalised)) {
		throw invalid(
			`slug must be lowercase letters, digits and single hyphens, at most ${SLUG_MAX_LENGTH} characters`
		);
	}
	return normalised;
}

/** The slug a project should get: the one asked for, else one derived from its name. */
export function slugFor(name: string, slug?: string | null): string {
	if (slug !== undefined && slug !== null && slug.trim() !== '') return assertSlug(slug);

	const derived = slugify(name);
	if (derived === '') throw invalid('could not derive a slug from name; pass slug explicitly');
	return derived;
}

function trimHyphens(value: string): string {
	return value.replace(/^-+|-+$/g, '');
}
