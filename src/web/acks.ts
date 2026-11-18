/**
 * When an agent's "thinking" stops being true (migration 013).
 *
 * `done` and `read` are facts about the past and never expire. `thinking` is a
 * claim about *now*, and the owner's report was that it "seems to hang around on
 * posts too long" — which it did, for two reasons that compound.
 *
 * Presence is per **agent**, and a claim to be thinking is really per **session**.
 * Several sessions share one bearer token in a normal setup, so while any of them
 * is beating the agent is "online" and every abandoned `thinking` any session
 * ever left keeps animating. And an agent that finishes without saying `done`
 * leaves one behind for ever, which is a mistake the dashboard should absorb
 * rather than pass on to the person reading it.
 *
 * So a claim also has to be recent. Everything here is a pure function of an
 * acknowledgement and an instant, which is what lets the rule be asserted on
 * numbers rather than on an animation somebody has to watch.
 */
import type { AckView } from './types';

/**
 * How long a claim to be thinking stays believable.
 *
 * The same window the server closes a silent session after (`SESSION_IDLE_MS`
 * in `$domain/sessions.ts`), and deliberately the same number rather than a
 * second one that could drift: the platform has already decided an agent silent
 * this long is gone, and an animation that outlived that decision is a lie.
 *
 * It is a ceiling on *silence*, not on work. An agent that is still going says
 * so again — `acknowledge` is explicit that sending twice is safe and leaves no
 * trail — and each send moves `updatedAt`, so a genuinely busy agent keeps its
 * animation for as long as it keeps claiming it.
 */
export const THINKING_MAX_AGE_MS = 10 * 60_000;

/**
 * Is this "thinking" still a claim about now?
 *
 * `true` for anything that is not a `thinking` at all: `done` and `read` are
 * facts about the past, and asking whether a fact has expired is the wrong
 * question. Callers filter on presence separately — being recent and being
 * online are two different things, and a claim needs both.
 */
export function thinkingIsCurrent(
	ack: Pick<AckView, 'state' | 'updatedAt'>,
	now: number,
	maxAgeMs: number = THINKING_MAX_AGE_MS
): boolean {
	if (ack.state !== 'thinking') return true;
	return now - ack.updatedAt < maxAgeMs;
}

/**
 * How long a message has to sit undelivered before the dashboard says so.
 *
 * The owner: "when a message isn't delivered yet, hold a red icon saying it
 * wasn't delivered to an agent."
 *
 * A grace period, because delivery is not instant and a red mark that flashed on
 * every message for a second would teach the reader to ignore it. Fifteen
 * seconds is comfortably longer than the round trip to a live agent — the server
 * pushes onto the stream the moment it publishes — and short enough that "nobody
 * is listening" is on screen while the owner is still looking at what they
 * wrote.
 */
export const UNDELIVERED_AFTER_MS = 15_000;

/**
 * Has this message reached nobody?
 *
 * `true` only when *all three* are true: nothing acknowledged it, nothing was
 * delivered, and it has been long enough that neither is still in flight. An
 * acknowledgement counts as delivery whether or not a delivery row exists — an
 * agent that replied plainly has it, and the mark is about reaching somebody
 * rather than about which table recorded it.
 *
 * The question only makes sense for a message *meant* for an agent: the caller
 * decides that, because who a card is for is a fact about the card rather than
 * about its acknowledgements. A card marked as work is one such case — its state
 * says where it has got to, which is a better answer than whether a delivery row
 * exists, and the cards migration 035 converted from the old board carry one
 * without ever having been delivered as messages at all.
 */
export function isUndelivered(
	message: { createdAt: number },
	acks: readonly Pick<AckView, 'id'>[],
	deliveries: readonly { id: string }[],
	now: number,
	afterMs: number = UNDELIVERED_AFTER_MS
): boolean {
	if (acks.length > 0 || deliveries.length > 0) return false;
	return now - message.createdAt >= afterMs;
}
