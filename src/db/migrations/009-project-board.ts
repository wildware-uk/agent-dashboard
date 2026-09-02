/**
 * A project's board columns (design §7).
 *
 * Tasks have four states and the board has however many columns the owner wants,
 * which is the whole reason this is a separate thing from `tasks.state`. A state
 * is what an agent set — `claim_task` writes `claimed` and `complete_task`
 * writes `done`, and every agent in the fleet depends on that vocabulary. A
 * column is how the owner wants to look at them. Letting the owner rename or
 * merge columns therefore costs nothing on the agent side, and letting them
 * invent a column agents cannot write would be a lane nothing ever enters.
 *
 * So a column is a title plus the states it gathers, stored as JSON on the
 * project: they are read and written together, nothing queries on them, and a
 * project with no board is a `NULL` rather than three rows that happen to say
 * the default.
 */
export const sql = `
ALTER TABLE projects ADD COLUMN board TEXT;
`;
