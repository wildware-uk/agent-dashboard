/**
 * How much a question needs the owner now, as an update already says (migration 007).
 *
 * An agent stopped on a question is always worth hearing about, so until now a
 * request had no priority. `critical` changes that: it pages the owner's phones
 * through Do Not Disturb, and an agent blocked on something that cannot wait
 * until morning has to be able to say so when it asks. Everything already asked
 * is `medium`, which is how it was treated.
 */
export const sql = `
ALTER TABLE approvals ADD COLUMN priority TEXT NOT NULL DEFAULT 'medium';
`;
