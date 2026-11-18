/**
 * A question you can talk about before you answer it.
 *
 * The owner: "allow me to reply to form questions, so I can discuss with the
 * agent before giving the answer."
 *
 * Until now a request was a one-shot: the buttons were the only way to say
 * anything back, so an owner who wanted to ask "why do you want to do that?"
 * had to answer something in order to be able to talk, or find the agent's card
 * elsewhere and reply there, where the agent — parked in `await_request` — was
 * looking at the request rather than the feed. A question with no room for a
 * question back is the wrong shape for the hardest decisions, which are exactly
 * the ones that get raised.
 *
 * So a request grows a thread, the same one every other card has (migration
 * 030): the discussion is a `messages` row anchored to the request, and every
 * piece of machinery a thread already has — unread counts, delivery, acks,
 * reactions, media, embeds — comes with it rather than being rebuilt.
 *
 * ## Why a column rather than a reuse of `update_id`
 *
 * A request often hangs off no card at all: `request_input` with a project and
 * nothing else is the common case, and there is no update to file the
 * conversation under. Borrowing the update's thread would also mix a decision
 * being negotiated into the card's public conversation, and the two are not the
 * same conversation.
 *
 * ## Why this is not a rebuild
 *
 * `ALTER TABLE ... ADD COLUMN` with a `REFERENCES` clause is legal in SQLite as
 * long as the default is NULL, which it is: every message that exists belongs to
 * no request, and that is the truth rather than a placeholder. The `CHECK`
 * constraints that forced migrations 026 and 031 to copy whole tables are on
 * other columns, untouched here.
 */
export const sql = `
ALTER TABLE messages ADD COLUMN request_id TEXT REFERENCES approvals (id);

-- One request's discussion, read every time the card renders.
CREATE INDEX messages_request ON messages (request_id);
`;
