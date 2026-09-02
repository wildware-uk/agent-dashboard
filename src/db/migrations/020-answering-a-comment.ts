/**
 * Answering one comment inside a thread.
 *
 * The owner: "Allow replying to comments, it would be ideal to keep all
 * relevant data in one thread." Both halves matter. A conversation on a card
 * frequently has two things going on at once, and until now a reply could only
 * be addressed to the card — so which remark it answered was left to whoever
 * read it to guess. But nesting threads inside threads is the shape nobody
 * wants either: a tree that grows sideways is a tree nobody can read on a
 * phone.
 *
 * So the thread stays one flat list and a message may *name* the one it
 * answers. `answers` is display, not structure: what thread a message belongs
 * to is still `update_id`, `task_id` or `reply_to`, unchanged, and a renderer
 * that ignores this column shows exactly what it showed before.
 *
 * Deliberately not `reply_to`. That column decides which post a feed reply
 * hangs under — it is the thread key — and overloading it would move a message
 * out of the thread it was written in, which is the opposite of what was asked
 * for.
 */
export const sql = `
ALTER TABLE messages ADD COLUMN answers TEXT REFERENCES messages (id);

-- Reading a thread means resolving every "in reply to" in it at once.
CREATE INDEX messages_answers ON messages (answers);
`;
