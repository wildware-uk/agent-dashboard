/**
 * The live-agents snapshot the right rail reads (design §4, §7).
 *
 * Presence is derived, never stored (§4), so there is nothing to subscribe to
 * and nothing to page: the answer is always "who is online *now*", computed from
 * two timestamps at the moment of the read. That is why this endpoint takes no
 * query at all, and why it is a separate route from `/api/snapshot` rather than
 * another field on it — the timeline is paged history, this is a live derivation,
 * and a client that wants one almost never wants the other at the same moment.
 *
 * Like every snapshot it is stamped with the stream cursor it is good to, by the
 * shared handler in `./snapshot.ts`: the rail applies this state and then treats
 * `agent.presence` frames above that seq as a reason to read it again.
 */
import { context, listLiveAgents, type DomainContext } from '$domain';

/**
 * The domain's own shape, named without importing `$db`.
 *
 * Recovered from the function's signature rather than re-declared, so the wire
 * format cannot drift from what the domain actually returns (the same trick
 * `./snapshot.ts` uses, for the same reason).
 */
export type SnapshotAgents = ReturnType<typeof listLiveAgents>;

/** Everyone the rail should be showing right now. */
export type AgentsSnapshot = { agents: SnapshotAgents };

/** Read the live agents. No query: presence has no filter and no pages. */
export function readAgentsSnapshot(ctx: DomainContext = context()): AgentsSnapshot {
	return { agents: listLiveAgents(ctx) };
}
