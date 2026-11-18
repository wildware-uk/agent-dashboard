/**
 * The board goes; a card can be the work.
 *
 * The owner: "remove tasks and the board, instead agents can mark a card in the
 * feed as a task, and update the status of the card, in progress, done, blocked
 * etc."
 *
 * A task was a second kind of thing in a second place. It had its own table, its
 * own page, its own five tools and its own half of every feature — a thread, but
 * not the card's thread; a status, which no card had; media and embeds bolted on
 * later so it would stop looking different (migration 030). The owner had to
 * look in two places to see what was happening, and an agent had to decide which
 * of two shapes its work was.
 *
 * So work stops being a kind of thing and becomes a *state* a card is in. Any
 * card can be marked as work and moved through `todo`, `in_progress`, `blocked`,
 * `done` or `cancelled`, and it keeps everything a card already has: its thread,
 * its pictures, its reactions, its pin, its acknowledgements.
 *
 * ## What happens to the tasks that exist
 *
 * They become posts in the feed they belonged to, carrying their state, and
 * everything filed against them comes with them.
 *
 * **Each task keeps its own id.** A ULID is unique on its own, so the post is
 * inserted with the task's id — which means every row that already points at a
 * task points at the post without anything having to be looked up. The thread on
 * a task becomes the thread on the post, its acknowledgements become the post's,
 * and so do its pictures and its emoji.
 *
 * **Who wrote it** is the claimant when it had one, and the owner otherwise.
 * `tasks` never recorded who created a task, only who was on it, so an
 * unassigned task is attributed to the owner — which is what they nearly all
 * were, and is visible on the card either way.
 *
 * **The title becomes the first line**, in bold, because a post has no title of
 * its own and a brief with its title thrown away is a worse record than one with
 * a bold line at the top.
 *
 * ## What is left behind on purpose
 *
 * The `tasks` table is not dropped and its rows are not deleted. Nothing reads
 * it after this, but the conversion above is the kind of thing worth being able
 * to check a week later, and deleting rows to save four kilobytes is a bad
 * trade. `updates.task_id` keeps its values for the same reason: those cards were
 * progress reports on work that is now a post, and the column is simply no longer
 * read.
 */
export const sql = `
-- Work is a state a card is in, on both kinds of card that stay.
ALTER TABLE updates ADD COLUMN status TEXT
	CHECK (status IN ('todo', 'in_progress', 'blocked', 'done', 'cancelled'));
ALTER TABLE messages ADD COLUMN status TEXT
	CHECK (status IN ('todo', 'in_progress', 'blocked', 'done', 'cancelled'));

-- What the feed asks for constantly: the work that is not finished.
CREATE INDEX updates_status ON updates (status) WHERE status IS NOT NULL;
CREATE INDEX messages_status ON messages (status) WHERE status IS NOT NULL;

-- Every task becomes a post, keeping its own id so that everything pointing at
-- it keeps pointing at it.
INSERT INTO messages (id, project_id, author, body, created_at, status)
SELECT
	tasks.id,
	tasks.project_id,
	CASE WHEN tasks.agent_id IS NULL THEN 'human' ELSE 'agent:' || tasks.agent_id END,
	CASE
		WHEN tasks.body = '' THEN '**' || tasks.title || '**'
		ELSE '**' || tasks.title || '**' || char(10) || char(10) || tasks.body
	END,
	tasks.created_at,
	CASE tasks.state
		WHEN 'todo' THEN 'todo'
		WHEN 'claimed' THEN 'in_progress'
		WHEN 'done' THEN 'done'
		WHEN 'cancelled' THEN 'cancelled'
	END
FROM tasks;

-- A task's thread becomes the post's thread. The id is the same value, so this
-- is a move of the anchor rather than a lookup.
UPDATE messages SET reply_to = task_id, task_id = NULL
	WHERE task_id IS NOT NULL AND reply_to IS NULL;
UPDATE messages SET task_id = NULL WHERE task_id IS NOT NULL;

UPDATE acknowledgements SET message_id = task_id, task_id = NULL WHERE task_id IS NOT NULL;
UPDATE media SET message_id = task_id, task_id = NULL WHERE task_id IS NOT NULL;
UPDATE embeds SET message_id = task_id, task_id = NULL WHERE task_id IS NOT NULL;
UPDATE reactions SET message_id = task_id, task_id = NULL WHERE task_id IS NOT NULL;
`;
