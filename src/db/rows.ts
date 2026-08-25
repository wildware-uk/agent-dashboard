/**
 * The narrow set of conversions between SQLite's storage classes and JavaScript.
 *
 * SQLite has no boolean and no JSON type, so booleans are stored 0/1 and
 * structured columns as TEXT. Every repository decodes through here rather than
 * hand-rolling the same ternary eleven times.
 */

/** SQLite 0/1 to boolean. */
export function boolOf(value: number): boolean {
	return value === 1;
}

/** boolean to SQLite 0/1. */
export function flagOf(value: boolean): 0 | 1 {
	return value ? 1 : 0;
}

/** Decode a JSON text column, tolerating null. */
export function jsonOf<T>(text: string | null): T | null {
	if (text === null) return null;
	return JSON.parse(text) as T;
}

/** Encode a value for a JSON text column, tolerating null and undefined. */
export function jsonText(value: unknown): string | null {
	return value === null || value === undefined ? null : JSON.stringify(value);
}

/** `undefined` (caller said nothing) collapses to `null` (the column is empty). */
export function orNull<T>(value: T | null | undefined): T | null {
	return value ?? null;
}
