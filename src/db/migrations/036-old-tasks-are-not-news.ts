/**
 * The converted tasks are history, not unread mail.
 *
 * Migration 035 turned every task into a post in its project's feed. Each post
 * is a new `messages` row, so it has a new `seq` — above every read cursor — and
 * the unread machinery correctly concluded that forty-six things had just been
 * said. Agents were notified about work they had finished weeks ago.
 *
 * That is the conversion's fault rather than the counter's, so the conversion
 * fixes it: every cursor is advanced past the rows the conversion wrote.
 *
 * Only forward, and only to the converted rows. A cursor is a claim about what
 * somebody has seen, and lowering one would hide real messages; the highest
 * converted `seq` in each project is exactly the line between "this was already
 * on the board" and "this was said afterwards".
 *
 * An agent with no cursor in a project gets none here either: a cursor is
 * created when it first reads, and the read that creates it will start from
 * whatever is unread at that moment — which, once this has run, is the messages
 * that were genuinely new.
 */
export const sql = `
UPDATE read_cursors
   SET last_seen_message_seq = (
	SELECT MAX(messages.seq)
	  FROM messages
	  JOIN tasks ON tasks.id = messages.id
	 WHERE messages.project_id = read_cursors.project_id
   )
 WHERE last_seen_message_seq < (
	SELECT COALESCE(MAX(messages.seq), 0)
	  FROM messages
	  JOIN tasks ON tasks.id = messages.id
	 WHERE messages.project_id = read_cursors.project_id
   );
`;
