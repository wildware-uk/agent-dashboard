/**
 * What every domain function needs to do its job.
 *
 * This is the template the rest of `src/domain/` follows: a function takes a
 * `DomainContext` first, then plain arguments, and returns plain objects. No
 * module-level singletons, so a test can hand over an in-memory database, a
 * private bus and a clock it controls, and no `Request`, `RequestEvent` or tool
 * shape ever reaches in here (design §2).
 */
import { getDatabase, type Db } from '$db';
import { bus as sharedBus, type EventBus } from '$events';

/** Milliseconds since the epoch, as `$db` stores every timestamp. */
export type Clock = () => number;

export type DomainContext = {
	/** The connection. Repositories take it; the domain never opens one itself. */
	db: Db;
	/** The single fan-out point. Every write publishes exactly one event here. */
	bus: EventBus;
	/** Read once per write, so one call cannot straddle two instants. */
	now: Clock;
};

/**
 * Fill in whatever the caller did not supply.
 *
 * Production calls `context()` and gets the process-wide database and bus; a
 * test passes all three. The database is only opened if it is actually needed,
 * so constructing a context in a test never reads the environment.
 */
export function context(overrides: Partial<DomainContext> = {}): DomainContext {
	return {
		db: overrides.db ?? getDatabase(),
		bus: overrides.bus ?? sharedBus,
		now: overrides.now ?? Date.now
	};
}
