/**
 * Acknowledgements: an agent saying "I have seen this" against one message or
 * one task.
 *
 * The gap this fills is not information, it is *silence*. The owner types a
 * reply and then watches a card that looks exactly the same as it did before —
 * an agent may have read it and be working on it, or may be wedged, or may
 * never have connected, and nothing on the screen tells the three apart. An
 * acknowledgement is the cheapest possible answer to that: two states, no body,
 * no thread of its own.
 *
 * **A row per (agent, target), not per acknowledgement.** "Thinking" becoming
 * "done" is the same claim being revised, not a second claim, and a history of
 * every state an agent passed through is a table that grows without anybody
 * ever reading it. The partial unique indexes below are what make that true in
 * the database rather than in whichever caller remembers.
 *
 * **Two nullable targets rather than one polymorphic pair.** A message and a
 * task are the two things an owner puts to an agent, they are both referenced
 * by foreign key, and a `(target_type, target_id)` column pair would give up
 * both of those to save one column. Exactly one is set; the domain refuses the
 * other three shapes.
 *
 * **No `note`.** A "thinking" that could carry a sentence would become a second
 * message channel next to `post_message`, and the two would drift. If an agent
 * has something to say it should say it.
 *
 * `created_at` is when the agent first acknowledged the thing and `updated_at`
 * is when it last changed its mind, because "acknowledged instantly, finished
 * twenty minutes later" is the interesting pair and one timestamp cannot say it.
 */
export const sql = `
CREATE TABLE acknowledgements (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	id TEXT NOT NULL,
	agent_id TEXT NOT NULL REFERENCES agents (id),
	message_id TEXT REFERENCES messages (id),
	task_id TEXT REFERENCES tasks (id),
	state TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX acknowledgements_id ON acknowledgements (id);

-- One live acknowledgement per agent per thing. Partial, because only one of
-- the two target columns is ever set and NULLs would otherwise collide.
CREATE UNIQUE INDEX acknowledgements_agent_message ON acknowledgements (agent_id, message_id)
	WHERE message_id IS NOT NULL;
CREATE UNIQUE INDEX acknowledgements_agent_task ON acknowledgements (agent_id, task_id)
	WHERE task_id IS NOT NULL;

-- The reads the dashboard makes: every acknowledgement on a thing it is about
-- to render.
CREATE INDEX acknowledgements_message ON acknowledgements (message_id);
CREATE INDEX acknowledgements_task ON acknowledgements (task_id);
`;
