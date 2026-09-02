/**
 * Linking an update to the task it is progress on (design §3, §7).
 *
 * The feed and the task list answer two different questions. A feed is "what
 * happened", read newest first and forgotten; a task is "what is being worked
 * on", which outlives any one thing that happened during it. Until now the two
 * could not be joined: an agent posting "step 3 of 7 done" had no way to say
 * *what* it was step 3 of, and an owner reading a task had no way to see the
 * work under it.
 *
 * Nullable, and always will be. Most updates are not about a task — an agent
 * reporting that a deploy finished is reporting on the world, not on a piece of
 * assigned work — and a column that insisted otherwise would turn every casual
 * post into a bookkeeping exercise.
 *
 * `messages.task_id` already exists (migration 001) and this deliberately mirrors
 * it: the two things that can hang off a task are a conversation and a report,
 * and they hang off it the same way.
 */
export const sql = `
ALTER TABLE updates ADD COLUMN task_id TEXT REFERENCES tasks (id);

-- The task page's own query: this task's updates, newest first.
CREATE INDEX updates_task_seq ON updates (task_id, seq DESC) WHERE task_id IS NOT NULL;
`;
