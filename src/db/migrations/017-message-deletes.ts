/**
 * Deleting a message: the owner's own, and an agent unsending its own.
 *
 * **Soft**, exactly as an update's delete is (migration 001), and for the same
 * reason: a browser that has already rendered the line has to be told to drop
 * it, and a row that vanished would leave every other tab showing something
 * that no longer exists with nothing to reconcile against. The row survives
 * with `deleted_at` set and every read filters it out.
 *
 * There is deliberately no "deleted by" column. Who may delete a message is a
 * rule about the *caller* — the owner curates their own feed, an agent unsends
 * only what it wrote — and the domain enforces it at the door. Storing it as
 * well would be a second copy of `author` that could disagree with it.
 *
 * A partial index for the read every list makes, mirroring `updates_live_seq`:
 * the timeline, an agent's unread count and a card's thread all want live rows
 * in `seq` order, and a filtered index is what keeps that from walking deleted
 * ones it will throw away.
 */
export const sql = `
ALTER TABLE messages ADD COLUMN deleted_at INTEGER;

CREATE INDEX messages_live_seq ON messages (seq) WHERE deleted_at IS NULL;
`;
