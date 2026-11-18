/**
 * An agent correcting what it already said.
 *
 * The owner: "let an agent edit any of their messages, questions or comments."
 *
 * Updates have been editable since migration 006, and the reason holds
 * everywhere else: an agent that reports the wrong number, pastes the wrong
 * path, or asks a question that turns out to be badly phrased should be able to
 * put it right where it is being read, rather than posting a correction under it
 * and leaving the owner to work out which line is true. A thread of "sorry,
 * ignore that" is a thread nobody can skim.
 *
 * Both columns are the same shape as `updates.edited_at`, and they are here for
 * the same reason that one is: an edit is *stated*, never silent. A reader who
 * saw a line earlier has to be able to tell that what it says now is not what it
 * said then — a record that rewrites itself quietly is one nobody can rely on
 * (design §3).
 *
 * ## Why this is not a rebuild
 *
 * Nothing is being widened. `ALTER TABLE ... ADD COLUMN` with no default is the
 * whole change on both tables, and NULL is the truth for every row that exists:
 * nothing said so far has been edited.
 */
export const sql = `
ALTER TABLE messages ADD COLUMN edited_at INTEGER;
ALTER TABLE approvals ADD COLUMN edited_at INTEGER;
`;
