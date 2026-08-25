/**
 * Test support for the domain (design §9).
 *
 * A domain test wants three things: a database that looks like a fresh
 * deployment, a bus it can read back, and a clock it controls. `harness()` is
 * all three wired into a {@link DomainContext}.
 *
 * This is a second, test-only entry point — deliberately not re-exported from
 * `./index.ts`, so nothing in a production path can reach an in-memory database.
 */
import { insertAgent, type Db } from '$db';
import { freshDatabase } from '$db/testing';
import { EventBus, type AppEvent } from '$events';
import { context, type Clock, type DomainContext } from './context';

export type Harness = DomainContext & {
	bus: EventBus;
	/** Every event the domain published, in order. */
	events: AppEvent[];
	/** Names of the events published, which is usually all an assertion needs. */
	eventNames(): string[];
	/** Insert an agent row directly: minting tokens belongs to a later slice. */
	agent(name?: string): string;
};

export type HarnessOptions = {
	/** A clock the test drives. Defaults to a fixed instant, so writes are stable. */
	now?: Clock;
	db?: Db;
};

/** A fixed, obviously-fake instant, so an assertion can quote a timestamp. */
export const FIXED_NOW = Date.UTC(2026, 7, 25, 9, 30, 0);

export function harness(options: HarnessOptions = {}): Harness {
	const db = options.db ?? freshDatabase();
	const bus = new EventBus();
	const events: AppEvent[] = [];
	bus.subscribe((event) => events.push(event));

	const ctx = context({ db, bus, now: options.now ?? (() => FIXED_NOW) });
	let agents = 0;

	return {
		...ctx,
		bus,
		events,
		eventNames: () => events.map((event) => event.type),
		agent(name = `agent-${(agents += 1)}`) {
			return insertAgent(db, { name, tokenHash: `hash-${name}` }).id;
		}
	};
}
