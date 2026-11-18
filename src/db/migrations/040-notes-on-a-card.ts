/**
 * What an agent knows about a card, said in fields rather than in prose.
 *
 * The owner: "allow agents to set metadata on cards, for example, branch name,
 * PR link, anything they like, they are hidden by default, but can be viewed on
 * the dashboard, and updated by the user and agent alike."
 *
 * ## Why rows rather than a JSON column on the card
 *
 * A blob would have been fewer lines and wrong in three ways.
 *
 * - **Authorship.** Each field records who set it and when, which is the
 *   difference between "the branch is `fix/fees`" and "*scout* said the branch
 *   is `fix/fees`, an hour ago". A blob has one author: whoever wrote last.
 * - **Two writers.** Two agents setting different fields on the same card is
 *   ordinary — one knows the branch, another opened the pull request. With a
 *   blob that is read-modify-write, and the second write silently drops the
 *   first. A row per field cannot lose one.
 * - **The card is not the owner of this.** `updates` and `messages` are what
 *   somebody said; this is a note pinned to it, and it is added and removed
 *   without the card changing at all.
 *
 * ## The card is named the generic way (migration 034)
 *
 * One nullable column per kind and a partial unique index per anchor, exactly as
 * `reactions` and `card_tags` do: SQLite cannot foreign-key a `(kind, id)` pair,
 * and `NULL` is not equal to itself, so one index across the three columns would
 * enforce nothing.
 *
 * ## Names are normalised, values are not
 *
 * `name` is stored twice: as typed, and as a `slug` that decides whether two
 * fields are the same one. "Branch", "branch" and "BRANCH" are one field, so an
 * agent setting it twice corrects itself rather than stacking up three rows that
 * look identical. The value is kept exactly as given — a branch name is
 * case-sensitive, and a URL certainly is.
 */
export const sql = `
CREATE TABLE card_fields (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	id TEXT NOT NULL UNIQUE,
	update_id TEXT REFERENCES updates (id),
	message_id TEXT REFERENCES messages (id),
	request_id TEXT REFERENCES approvals (id),
	-- What it is called, as it is shown.
	name TEXT NOT NULL,
	-- The same, normalised: what "already set" is judged on.
	slug TEXT NOT NULL,
	-- What it says. Text, always: this is a note, not a type system.
	value TEXT NOT NULL,
	-- Who set it last: the literal 'human', or 'agent:<id>'.
	author TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
) STRICT;

-- One field of each name per card, per anchor. Partial, because NULL is not
-- equal to itself and one index across the three columns would enforce nothing.
CREATE UNIQUE INDEX card_fields_update_slug ON card_fields (update_id, slug)
	WHERE update_id IS NOT NULL;
CREATE UNIQUE INDEX card_fields_message_slug ON card_fields (message_id, slug)
	WHERE message_id IS NOT NULL;
CREATE UNIQUE INDEX card_fields_request_slug ON card_fields (request_id, slug)
	WHERE request_id IS NOT NULL;

-- The read the feed makes: every field on the cards it is rendering.
CREATE INDEX card_fields_update ON card_fields (update_id);
CREATE INDEX card_fields_message ON card_fields (message_id);
CREATE INDEX card_fields_request ON card_fields (request_id);
`;
