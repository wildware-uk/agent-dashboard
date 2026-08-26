/**
 * Owner requests (design §5): the `approvals` table grows the four columns a
 * request of any kind needs.
 *
 * Migrations are append-only, and other slices already read every column
 * migration 001 created, so this adds and never reshapes. That constraint is
 * also why `kind` has no `CHECK`: SQLite cannot add one to a live table without
 * rebuilding it, and rebuilding `approvals` to police a value the domain already
 * refuses would trade a real risk (a rebuild that drops a constraint or an index
 * by accident) for a theoretical one.
 *
 * The same reasoning keeps the `state` values exactly as 001 wrote them. A
 * settled request is `approved` or `rejected` in this column — `confirm` uses
 * both, every other kind only ever writes `approved` — and the structured answer
 * lives in `answer`. `$domain` presents that pair as one `answered` state, so the
 * vocabulary an agent sees is the design's without the table having to be
 * rewritten underneath the slices already reading it.
 *
 * - `kind` — which of the five request kinds this is (design §5). Defaulted to
 *   `confirm` so rows written before this migration keep their exact meaning:
 *   before it, every row *was* an approval.
 * - `detail` — the longer explanation under the question, optional.
 * - `config` — the kind-specific knobs as JSON: `placeholder`, `multiline`,
 *   `default`, `min`, `max`. One column rather than five, because they are read
 *   and written together, never queried on.
 * - `answer` — the structured answer as JSON (`{kind, value}`), where `value` is
 *   a string, a boolean or a list of strings. `decided_value` stays what it
 *   always was: the single scalar a human decision produced, which is a
 *   convenience for reading the table by hand, never the authority.
 */
export const sql = `
ALTER TABLE approvals ADD COLUMN kind TEXT NOT NULL DEFAULT 'confirm';
ALTER TABLE approvals ADD COLUMN detail TEXT;
ALTER TABLE approvals ADD COLUMN config TEXT;
ALTER TABLE approvals ADD COLUMN answer TEXT;

-- The heartbeat's count: this agent's pending requests (design §5).
CREATE INDEX approvals_agent_state ON approvals (agent_id, state);
`;
