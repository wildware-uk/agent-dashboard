/**
 * Row identifiers.
 *
 * ULIDs: 26 characters, lexicographically sortable by creation time, and safe
 * to hand to an agent or put in a URL (design §3). The monotonic factory keeps
 * two ids minted in the same millisecond in insertion order, so sorting by `id`
 * agrees with sorting by `seq`.
 */
import { monotonicFactory } from 'ulid';

const next = monotonicFactory();

/** A fresh ULID for a new row. */
export function newId(): string {
	return next();
}

/** Length of a ULID, for validation at the edges. */
export const ID_LENGTH = 26;

/** Whether a string looks like a ULID this app would have minted. */
export function isId(value: string): boolean {
	return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value);
}
