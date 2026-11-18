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
	'acknowledgements',
	'message_deliveries',
	'notifications',
	'reactions',
	'embed_types',
	'embeds',
	// Migration 039: a project's own vocabulary, and one of its words on a card.
	'tags',
	'card_tags',
	// Migration 040: what an agent knows about a card, in fields.
	'card_fields',
	// Migration 041: interactive UI an agent supplies, and one showing of it.
	'apps',
	'app_views',
	// Migration 043: the owner's phones, each with its own key and push tokens.
	'owner_devices',
	// Migration 044: the agents a message names with @name.
	'message_mentions'
] as const;

export type TableName = (typeof TABLES)[number];

/** Bookkeeping table written by the migration runner; not part of the data model. */
export const MIGRATIONS_TABLE = 'schema_migrations';
