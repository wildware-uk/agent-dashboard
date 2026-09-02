/**
 * The table list, as data.
 *
 * The migrations own the DDL; this is the one place that names the resulting
 * tables so tests, and anything that needs to iterate the schema, do not
 * re-derive the list from SQL text.
 */
export const TABLES = [
	'projects',
	'agents',
	'sessions',
	'updates',
	'media',
	'derivatives',
	'upload_tokens',
	'tasks',
	'messages',
	'read_cursors',
	'approvals',
	'push_subscriptions',
	'update_shares',
	'acknowledgements'
] as const;

export type TableName = (typeof TABLES)[number];

/** Bookkeeping table written by the migration runner; not part of the data model. */
export const MIGRATIONS_TABLE = 'schema_migrations';
