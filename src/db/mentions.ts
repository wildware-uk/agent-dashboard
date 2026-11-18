/**
 * `message_mentions` (migration 044): the agents a message names with `@name`.
 *
 * Which names count is `$domain`'s to decide; this layer stores the answer. A
 * message's set is replaced whole, because an edit can add a name and drop
 * another, and a diff would be two statements doing what one delete and an
 * insert already say.
 */
import type { Db } from './connection';
import { newId } from './ids';

/** Make these the agents this message names, and no others. */
export function setMessageMentions(db: Db, messageId: string, agentIds: readonly string[]): void {
	const clear = db.prepare<[string]>(`DELETE FROM message_mentions WHERE message_id = ?`);
	const insert = db.prepare<[string, string, string]>(
		`INSERT INTO message_mentions (id, message_id, agent_id) VALUES (?, ?, ?)
		 ON CONFLICT (message_id, agent_id) DO NOTHING`
	);

	db.transaction(() => {
		clear.run(messageId);
		for (const agentId of agentIds) insert.run(newId(), messageId, agentId);
	})();
}

/** The agents one message names, in the order they were stored. */
export function listMessageMentions(db: Db, messageId: string): string[] {
	return db
		.prepare<[string], { agent_id: string }>(
			`SELECT agent_id FROM message_mentions WHERE message_id = ? ORDER BY seq`
		)
		.all(messageId)
		.map((row) => row.agent_id);
}
