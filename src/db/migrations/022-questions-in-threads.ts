/**
 * A question asked inside a thread.
 *
 * The owner: "Allow agents to ask questions in replies." An agent that has been
 * talking to them in a thread and then needs a decision had only one way to ask
 * — `request_input`, which surfaced as a card of its own at the top of the feed,
 * away from the conversation that produced it. So the owner read a question with
 * none of the context they had just been discussing, and the thread they *were*
 * reading went silent with no sign that anything was waiting.
 *
 * `message_id` is the thread it was asked in, the same shape `update_id`
 * (migration 002) already gives for a question that follows from a card. It
 * changes where the question is *rendered*, and nothing else: the same row, the
 * same wait, the same answer validation.
 */
export const sql = `
ALTER TABLE approvals ADD COLUMN message_id TEXT REFERENCES messages (id);

-- The read a thread makes: every question asked in it.
CREATE INDEX approvals_message ON approvals (message_id);
`;
