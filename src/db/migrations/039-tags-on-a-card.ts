/**
 * Tags a project decides for itself, put on cards in one click.
 *
 * The owner: "allow users and agents to define tags for a project, ie 'feature,
 * bug, high priority' etc, and these can be included on feed posts by agents and
 * users in one click."
 *
 * ## Two tables, because they are two different things
 *
 * `tags` is the project's vocabulary: the words this project uses, defined once
 * and then offered as buttons. `card_tags` is one of those words being put on
 * one card. Keeping them apart is what makes the click a click — the picker
 * lists a project's tags, and choosing one writes a row rather than typing a
 * word again — and it is what lets a tag be renamed or retired without walking
 * every card that carries it.
 *
 * ## Why not `level` or `status`
 *
 * The dashboard already has two words for a card: `level` (how it went) and
 * `status` (where the work is). Both are closed lists the product decides, and
 * that is deliberate — a level everybody invents means nothing. A tag is the
 * opposite: it is the *project's* word, invented by whoever works there, and
 * there can be several on one card. So it is its own thing rather than a third
 * enum nobody could agree on.
 *
 * ## The card is named the generic way (migration 034)
 *
 * One nullable column per kind, and a partial unique index per anchor, exactly
 * as `reactions` does: SQLite cannot foreign-key a `(kind, id)` pair, and `NULL`
 * is not equal to itself, so one index across the three columns would enforce
 * nothing. A question can be tagged for the same reason it can be pinned and
 * reacted to — the card refactor's whole point is that a card is a card.
 *
 * Tags are scoped to a project, and a card belongs to one, so a card can only
 * ever carry its own project's words. Nothing here enforces that — it is the
 * domain's job, where the card and the tag are both resolved.
 */
export const sql = `
CREATE TABLE tags (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	id TEXT NOT NULL UNIQUE,
	project_id TEXT NOT NULL REFERENCES projects (id),
	-- The word as it is written on the card.
	name TEXT NOT NULL,
	-- The same word, normalised: what "already defined" is judged on, so "Bug",
	-- "bug" and " bug " are one tag rather than three that look identical.
	slug TEXT NOT NULL,
	-- One of the palette's names ('rose', 'amber', …), or NULL for the default.
	-- A name rather than a colour value: the dashboard has two themes, and a
	-- stored hex would be legible in exactly one of them.
	colour TEXT,
	-- Who defined it: an agent, or NULL for the owner. The same rule media keeps.
	agent_id TEXT REFERENCES agents (id),
	created_at INTEGER NOT NULL
) STRICT;

-- One tag per word per project. Two projects may both have "bug"; one project
-- may not have it twice.
CREATE UNIQUE INDEX tags_project_slug ON tags (project_id, slug);

CREATE TABLE card_tags (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	id TEXT NOT NULL UNIQUE,
	tag_id TEXT NOT NULL REFERENCES tags (id),
	update_id TEXT REFERENCES updates (id),
	message_id TEXT REFERENCES messages (id),
	request_id TEXT REFERENCES approvals (id),
	-- Who put it on: the literal 'human', or 'agent:<id>'. The vocabulary every
	-- other card feature uses.
	author TEXT NOT NULL,
	created_at INTEGER NOT NULL
) STRICT;

-- One of each tag per card, per anchor: partial, because NULL is not equal to
-- itself and one index across the three columns would enforce nothing.
CREATE UNIQUE INDEX card_tags_update ON card_tags (tag_id, update_id)
	WHERE update_id IS NOT NULL;
CREATE UNIQUE INDEX card_tags_message ON card_tags (tag_id, message_id)
	WHERE message_id IS NOT NULL;
CREATE UNIQUE INDEX card_tags_request ON card_tags (tag_id, request_id)
	WHERE request_id IS NOT NULL;

-- The reads the feed makes: every tag on the cards it is rendering.
CREATE INDEX card_tags_update_card ON card_tags (update_id);
CREATE INDEX card_tags_message_card ON card_tags (message_id);
CREATE INDEX card_tags_request_card ON card_tags (request_id);
-- And the read a tag's removal makes: every card carrying it.
CREATE INDEX card_tags_tag ON card_tags (tag_id);
`;
