/**
 * The failures the domain reports.
 *
 * The domain cannot throw an HTTP status or an MCP error: it does not know which
 * front door the caller came through (design §2). It throws a `DomainError`
 * carrying a small, closed `code`, and each adapter maps that onto its own
 * vocabulary — `$http` onto 400/404/409, `$mcp` onto a tool error. Every later
 * domain module reuses these three codes rather than inventing a fourth.
 */

/** Why a call failed, in terms the domain can be sure of. */
export type DomainErrorCode =
	/** The caller's arguments cannot be honoured, whatever the state of the data. */
	| 'invalid_argument'
	/** The thing named does not exist. */
	| 'not_found'
	/** The arguments are fine, but the current state refuses them. */
	| 'conflict';

/** An expected, reportable failure. Anything else escaping the domain is a bug. */
export class DomainError extends Error {
	readonly code: DomainErrorCode;

	constructor(code: DomainErrorCode, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = 'DomainError';
		this.code = code;
	}
}

/** The caller sent something the domain will not accept. */
export function invalid(message: string, options?: { cause?: unknown }): DomainError {
	return new DomainError('invalid_argument', message, options);
}

/** No such row. */
export function notFound(message: string, options?: { cause?: unknown }): DomainError {
	return new DomainError('not_found', message, options);
}

/** The write would collide with something already stored. */
export function conflict(message: string, options?: { cause?: unknown }): DomainError {
	return new DomainError('conflict', message, options);
}

/**
 * Whether a caught value is one of ours.
 *
 * Adapters use this to tell "the agent asked for something impossible", which is
 * worth reporting verbatim, from "the domain has a bug", which is not.
 */
export function isDomainError(value: unknown): value is DomainError {
	return value instanceof DomainError;
}
