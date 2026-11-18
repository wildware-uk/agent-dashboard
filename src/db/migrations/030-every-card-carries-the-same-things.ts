/**
 * Media and embeds on approvals and tasks, so every card can carry the same things.
 *
 * The owner: "approval boxes cannot contain embeds, standardize the approach on
 * cards, all card types support all the same things."
 *
 * They are right, and the shape of the mistake is worth naming. There was never
 * a decision that an approval should be plain text — media landed on updates
 * (design §6), then on messages (migration 016), then embeds landed on updates
 * and messages (migration 027), and each time the two card types that were not
 * in front of anybody were left behind. What the owner is looking at is four
 * kinds of card with four different vocabularies, and no reason for any of it.
 *
 * So an approval and a task now hang media and embeds the same way an update and
 * a message do: a nullable foreign key on the thing being attached, rather than
 * a join table, because an attachment belongs to exactly one card.
 *
 * ## Why this is safe as an ALTER rather than a rebuild
 *
 * `media` has a `CHECK` on `kind` and SQLite cannot widen one in place — which
 * is what made migrations 016 and 026 rebuilds. Adding a *column* is not that:
 * `ALTER TABLE ... ADD COLUMN` is legal on a STRICT table, and legal with a
 * `REFERENCES` clause precisely because the default is `NULL` and so no existing
 * row can violate it. Nothing is copied and no index is at risk of being
 * silently dropped, which is the failure a rebuild has to be careful about.
 *
 * ## The sweeper
 *
 * `listOrphanedMedia` collects media with no update and no message. Two more
 * ways to be spoken for means two more clauses there, and forgetting them would
 * delete an approval's screenshot an hour after it was asked — which is exactly
 * what happened to an embed's avatar the day embeds shipped.
 */
export const sql = `
-- The card this is attached to, when it is an approval or a task. Exactly one
-- of the four is ever set; the domain enforces that, as it always has.
ALTER TABLE media ADD COLUMN request_id TEXT REFERENCES approvals (id);
ALTER TABLE media ADD COLUMN task_id TEXT REFERENCES tasks (id);

ALTER TABLE embeds ADD COLUMN request_id TEXT REFERENCES approvals (id);
ALTER TABLE embeds ADD COLUMN task_id TEXT REFERENCES tasks (id);

-- The reads a card makes as it renders, matching media_update and media_message.
CREATE INDEX media_request ON media (request_id);
CREATE INDEX media_task ON media (task_id);
CREATE INDEX embeds_request ON embeds (request_id);
CREATE INDEX embeds_task ON embeds (task_id);
`;
