/**
 * Put back the replies that were rendered nowhere.
 *
 * The owner found this by using it: "agents post messages, I click the
 * notification, and it doesn't take me to the message, nor can I find it
 * anywhere on the dashboard." Both halves were true, and the second is the
 * serious one — the message existed, it notified, and no view rendered it.
 *
 * The owner replies *inside* a card's thread, so their line carries that card's
 * `update_id`. An agent answering it named that line as `reply_to`, and the
 * flattening rule — written for the owner's feed posts, which anchor to nothing
 * — filed the answer with a `reply_to` and no `update_id`. Nothing reads that
 * shape: a card's thread is read by `update_id`, a feed post is a message with
 * no `reply_to`, and replies are only collected under posts.
 *
 * `$domain` no longer produces it (a reply to a message already in a thread
 * joins that thread and names what it answers). This repairs the rows already
 * written: they take the thread of the message they answered, and what they
 * were replying to becomes `answers`, which is exactly what the thread renders
 * as "answering scout".
 *
 * Deliberately narrow. Only rows with no thread of their own whose parent has
 * one are touched; a reply under a feed post is left exactly as it is, because
 * that shape was always correct.
 */
export const sql = `
UPDATE messages AS reply
SET
	update_id = (SELECT parent.update_id FROM messages AS parent WHERE parent.id = reply.reply_to),
	task_id = (SELECT parent.task_id FROM messages AS parent WHERE parent.id = reply.reply_to),
	answers = COALESCE(reply.answers, reply.reply_to),
	reply_to = NULL
WHERE reply.update_id IS NULL
  AND reply.task_id IS NULL
  AND reply.reply_to IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM messages AS parent
     WHERE parent.id = reply.reply_to
       AND (parent.update_id IS NOT NULL OR parent.task_id IS NOT NULL)
  );
`;
