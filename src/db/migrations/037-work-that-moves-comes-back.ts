/**
 * A card that moves comes back to the top.
 *
 * The owner: "make it so when a cards work status is updated, it moves to the
 * top of the feed."
 *
 * The feed already files a card by when something last happened to it rather
 * than when it was posted — that was the change that made a reply bump its card
 * (`src/web/activity.ts`). Moving work along is the same kind of event and was
 * not counted: an agent picking something up, or marking it blocked, left the
 * card exactly where it was, which is the one place the owner would not look.
 *
 * So the moment a state changes is recorded. It is a separate column rather than
 * a reuse of `edited_at` because the two say different things and are read by
 * different parts of the page: an edit changes the words and says so on the
 * card, and this changes where the card sits.
 *
 * Existing rows get `NULL`, which the feed reads as "no state change to account
 * for" and files them by their own age — right for cards that were never marked,
 * and right for the ones migration 035 converted, whose state was set by that
 * conversion rather than by anybody working on them. Backfilling those would
 * have dragged forty-six finished tasks to the top of the feed on first paint.
 */
export const sql = `
ALTER TABLE updates ADD COLUMN status_at INTEGER;
ALTER TABLE messages ADD COLUMN status_at INTEGER;
`;
