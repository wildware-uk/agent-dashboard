/**
 * A message can hang off another message (the owner's feed posts).
 *
 * Until now a message anchored to an update, a task, or a project — the first
 * two give it a thread to live in, and the third is a note with nowhere in
 * particular to be. The owner's composer posts the third kind and it *is* the
 * thing being talked about, so it needs replies of its own.
 *
 * An added column rather than a rebuild, which is the constraint every
 * migration here works within: `messages` is read by the timeline, the channel
 * and every agent's `get_messages`, and a table rebuild to add threading would
 * put all of that at risk to avoid a nullable column.
 *
 * **One level, on purpose.** A reply's `reply_to` always names a *post*, never
 * another reply. Threads of threads are a shape nobody asked for and a renderer
 * nobody wants to write.
 *
 * The domain keeps that by flattening rather than refusing: answering a reply
 * files the answer under the same post. Refusing was the first attempt and it
 * was wrong — the owner replies inside threads, so their message is itself a
 * reply, and an agent answering them was refused for doing the obvious thing.
 */
export const sql = `
ALTER TABLE messages ADD COLUMN reply_to TEXT REFERENCES messages (id);

-- The read a card makes: every reply under one post, oldest first.
CREATE INDEX messages_reply_to ON messages (reply_to);
`;
