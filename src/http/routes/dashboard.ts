/**
 * The server render behind the shell (design §7).
 *
 * Shared by `/` and `/projects/[slug]`, which are the same page with a
 * different scope, so there is one place that decides what a freshly loaded
 * dashboard knows.
 *
 * Not a route file: SvelteKit only treats `+`-prefixed files in the route tree
 * as routes, so a plain module can live here next to the two loads that use it.
 */
import { error } from '@sveltejs/kit';
import { bus } from '$events';
import { isDomainError } from '$domain';
import {
	SNAPSHOT_DEFAULT_LIMIT,
	readFullSnapshot,
	type FullSnapshot,
	type Snapshot
} from '../stream';

/** A `DomainError` code is the domain's vocabulary; this is HTTP's (design §2). */
const STATUS_FOR = { invalid_argument: 400, not_found: 404, conflict: 409 } as const;

/** What both dashboard routes hand their page. */
export type DashboardData = {
	/** The selected project's slug, or `null` for the whole timeline. */
	project: string | null;
	snapshot: Snapshot<FullSnapshot>;
};

/**
 * Read the state the shell paints with, stamped with the stream cursor it is
 * good to.
 *
 * The cursor is read **before** the state, for the reason spelled out in
 * `src/http/stream/snapshot.ts`: `seq` has to mean "this state accounts for
 * every event up to here". Reading it afterwards would let an event published
 * mid-read be dismissed by the client as already-included, and the browser would
 * sit on stale data until its next reconnect.
 *
 * This is deliberately the same function `GET /api/snapshot` serves, so the
 * server render and the post-`resync` refetch cannot drift apart.
 */
export function loadDashboard(project: string | null): DashboardData {
	const seq = bus.lastSeq;

	let state: FullSnapshot;
	try {
		state = readFullSnapshot({ limit: SNAPSHOT_DEFAULT_LIMIT, ...(project ? { project } : {}) });
	} catch (cause) {
		if (!isDomainError(cause)) throw cause;
		// A link to a project that has been deleted, or a hand-typed slug. Saying
		// so beats rendering the whole timeline as if that were what was asked for.
		error(STATUS_FOR[cause.code], cause.message);
	}

	return { project, snapshot: { seq, at: new Date().toISOString(), ...state } };
}
