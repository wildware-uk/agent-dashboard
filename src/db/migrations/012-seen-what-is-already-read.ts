/**
 * Treat everything that exists right now as already read.
 *
 * Migration 011 left `owner_seen_at` NULL, and `NULL` counts a project's whole
 * history as new — which is right for a project created from now on, and wrong
 * for the ones already on the dashboard when the badge shipped. Without this the
 * owner's first load says "555 new" against a project they have been reading all
 * week, which is not a badge, it is an accusation.
 *
 * A backfill rather than a change to 011: an applied migration is never edited,
 * and this states the thing that is actually true — at the moment the badge
 * arrived, everything before it had been seen.
 *
 * New projects keep the NULL, and keep the whole-history meaning with it: a
 * project created after this ran has no history the owner could already have
 * read.
 */
export const sql = `
UPDATE projects
   SET owner_seen_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE owner_seen_at IS NULL;
`;
