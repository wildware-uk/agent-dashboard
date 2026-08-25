/**
 * The two string checks every domain module needs.
 *
 * Adapters validate shapes (`$mcp` with zod, `$http` at the route); the domain
 * still validates meaning, because it is reachable from both and "the body is
 * not blank" is a rule, not a transport concern.
 *
 * Both functions trim, so an agent that pads a field does not store the padding
 * and does not fail a length check on whitespace.
 */
import { invalid } from './errors';

/** Trim and require something to be left. */
export function requiredText(value: string, field: string, maxLength: number): string {
	const trimmed = value.trim();
	if (trimmed === '') throw invalid(`${field} is required`);
	return withinLimit(trimmed, field, maxLength);
}

/**
 * Trim, and collapse "absent" and "blank" to `null`.
 *
 * `undefined` (the caller said nothing) and `''` (the caller said nothing, in a
 * form field) mean the same thing to a nullable column.
 */
export function optionalText(
	value: string | null | undefined,
	field: string,
	maxLength: number
): string | null {
	const trimmed = value?.trim() ?? '';
	return trimmed === '' ? null : withinLimit(trimmed, field, maxLength);
}

function withinLimit(value: string, field: string, maxLength: number): string {
	if (value.length > maxLength) {
		throw invalid(`${field} must be at most ${maxLength} characters`);
	}
	return value;
}
