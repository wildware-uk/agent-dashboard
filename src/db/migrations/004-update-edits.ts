/**
 * Agents editing their own updates (design §3, §5).
 *
 * One column. An update was write-once until now — an agent posted it and the
 * only later change was the owner's pin or a soft delete — and the reason to
 * record `edited_at` rather than quietly rewriting the row is that a timeline is
 * read as a record of what happened: a card whose text changed with nothing
 * saying so is a card the owner cannot trust they read correctly the first time.
 *
 * Deliberately *not* here: a revision history. Keeping every version would make
 * the timeline a document store, and the product is a status wall — what the
 * agent means *now* is what the owner needs. The one thing worth keeping is that
 * it changed, and when.
 *
 * `created_at` is untouched by an edit, so an update stays where the owner last
 * saw it rather than jumping to the top of the feed because a typo was fixed.
 */
export const sql = `
ALTER TABLE updates ADD COLUMN edited_at INTEGER;
`;
