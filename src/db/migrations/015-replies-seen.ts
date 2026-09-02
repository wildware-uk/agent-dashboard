/**
 * When the owner last read the conversation on an update.
 *
 * "Recent replies" lifts a card out of its day and parks it at the top of the
 * feed while a conversation is live on it. That was right for the first hour and
 * wrong afterwards: with nothing to say "I have read this", the section only
 * ever grew, and the cards riding above the timeline became the ones the owner
 * had been ignoring the longest.
 *
 * So the same shape as `projects.owner_seen_at` (migration 011), for the same
 * reason: server-side, because a section that cleared on the phone and stayed
 * lit on the desk would be worse than one that never cleared at all.
 *
 * `NULL` means never read, which is what every existing card means — a card
 * whose thread is genuinely new should ride the top, and that is the state they
 * are all in today.
 */
export const sql = `
ALTER TABLE updates ADD COLUMN replies_seen_at INTEGER;
`;
