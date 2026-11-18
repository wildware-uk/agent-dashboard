/**
 * Acknowledgements: an agent answering a message or a task without words
 * (migration 013).
 *
 * ## What this is for
 *
 * The owner types a reply and then looks at a card that has not changed. An
 * agent may have read it and started work, or be wedged, or never have
 * connected — and the dashboard shows the same thing in all three cases. That
 * silence is the whole problem this solves, and it is why the vocabulary is two
 * words rather than a status field somebody would have to design.
 *
 * - `thinking` — "I have this, I am on it." A claim about *now*: it is only
 *   true while the agent is alive, so the dashboard shows it only while that
 *   agent is online (`src/web/`). An animation still running against an agent
 *   that died an hour ago is worse than no acknowledgement at all, because it
 *   is a lie the owner has no way to check.
 * - `read` — "I have seen this." Also a fact about the past, and the smallest
 *   thing an agent can honestly say.
 * - `done` — "this is finished." A fact about the past, so it stays put whether
 *   or not the agent is still there.
 *
 * ## What it deliberately is not
 *
 * It is not a message. There is no body — an agent with something to say has
 * `post_message`, and a status vocabulary that grows past the point where a
 * glance decodes it has stopped being a glance.
 *
 * `read` is the one word that has been added since, and it was added because
 * two states were not being used as designed: agents reach for `thinking` and
 * leave it there, because `done` sounds like a claim about the *work* and they
 * are reluctant to make it about a message. So they said nothing at all, which
 * is the silence this whole feature exists to end. "I have seen this" is the
 * smaller, truer thing, and an agent will say it.
 *
 * It is also not a task state. `complete_task` is what finishes work; a `done`
 * acknowledgement on a task says "I have dealt with what you asked me here",
 * which is a different and smaller claim — an owner's note on a task is
 * frequently answered without the task itself finishing.
 *
 * ## Where the code went (migration 034)
 *
 * Acknowledging is one of the features every card shares, so the act itself
 * lives in `./cards.ts` with pinning and reactions: an agent saying "seen it"
 * about an update is the same act as saying it about a message, and the owner
 * asked for exactly that — "they should all share the same features, and be
 * implemented in a generic modular fashion". What stays here is this
 * explanation, which is about the vocabulary rather than the plumbing, and the
 * names the rest of the product imports.
 */
export {
	ACK_STATES,
	acknowledgeCard as acknowledge,
	acknowledgementsFor,
	type AcknowledgeCardInput as AcknowledgeInput,
	type AcknowledgementScope
} from './cards';
