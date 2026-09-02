/**
 * Per-project styling (design §3, §7): a logo and two colours.
 *
 * One JSON column rather than three typed ones, for the same reason
 * `approvals.config` is one: the fields travel together, nothing queries on
 * them, and a project with no theme is a `NULL` rather than three columns each
 * having to mean "unset".
 *
 * **The colours are stored as text and that is exactly why the domain is strict
 * about them.** These values end up in a CSS custom property on the owner's own
 * dashboard, and agents can set them — so `src/domain/projects.ts` accepts a hex
 * literal and nothing else. A column that will hold whatever it is given makes
 * the validation the only thing standing between an agent and a stylesheet, and
 * it is written down in one place for that reason.
 *
 * The logo is a media id, not a URL. A URL would be a request the owner's
 * browser makes to somewhere this deployment does not control, on every page
 * load, with a referrer — the media pipeline already exists and already serves
 * bytes this deployment vouched for (§6).
 */
export const sql = `
ALTER TABLE projects ADD COLUMN theme TEXT;
`;
