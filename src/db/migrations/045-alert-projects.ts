/**
 * Which projects a phone wants alerts about (iOS Focus filters).
 *
 * A JSON array of project ids, or NULL for every project — which is what every
 * existing phone keeps, so nothing changes until the app sets a list. Ids
 * rather than slugs, so renaming a project does not quietly drop it from a
 * phone's list.
 */
export const sql = `
ALTER TABLE owner_devices ADD COLUMN alert_project_ids TEXT;
`;
