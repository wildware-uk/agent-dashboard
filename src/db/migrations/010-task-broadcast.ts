/**
 * Broadcasting a task to a project's agents (issue: "send a task via a channel
 * to the agents of a specific project").
 *
 * `open_tasks` has always meant *this agent's* `todo` and `claimed` rows, and
 * that is load-bearing: an unassigned task counted for everybody would tell
 * every agent in the deployment it had work to do. So until now an unassigned
 * task notified nobody, and sending work to a project meant picking one agent by
 * hand and hoping it was the one that was online.
 *
 * This column is the third case, and it exists precisely so the rule above can
 * stay. An accidental queue is still silent; a task the owner deliberately
 * *aimed* at a project is not. `claim_task` is already a single conditional
 * UPDATE, so the fan-out settles itself: one winner, and a clean `conflict` for
 * everyone else.
 *
 * A timestamp rather than a flag, because "when did this go out" is the question
 * asked immediately afterwards, and `NULL` already means "not broadcast".
 */
export const sql = `
ALTER TABLE tasks ADD COLUMN broadcast_at INTEGER;
`;
