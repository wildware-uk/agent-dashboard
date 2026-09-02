/**
 * When the owner last looked at a project, so the sidebar can badge what is new.
 *
 * On the project rather than in a `project_views` table because there is exactly
 * one owner (design §1): a row per (owner, project) would be a join to carry a
 * column, and the deployment has no second person to disambiguate it for.
 *
 * Server-side rather than in the browser for the same reason it is worth having
 * at all — the owner reads the dashboard on a phone and on a desk, and a badge
 * that cleared on one device and not the other would be worse than no badge.
 *
 * `NULL` means never opened, which is deliberately not the same as "opened at
 * the epoch": a project created while the owner was away should badge its whole
 * history, and a `COALESCE` to 0 gives exactly that without a special case.
 */
export const sql = `
ALTER TABLE projects ADD COLUMN owner_seen_at INTEGER;
`;
