/**
 * The ordered migration list.
 *
 * Migrations are numbered, append-only, and never edited once applied — the
 * runner refuses to start if an applied migration's SQL has changed, because
 * the database in front of it no longer matches the code's idea of it.
 */
import { sql as initialSchema } from './001-initial-schema';
import { sql as ownerRequests } from './002-owner-requests';

export type Migration = {
	/** 1-based, contiguous, and permanent once shipped. */
	version: number;
	/** Human label, recorded alongside the version so a log line reads. */
	name: string;
	/** One or more statements, applied as a single transaction. */
	sql: string;
};

export const MIGRATIONS: readonly Migration[] = [
	{ version: 1, name: 'initial-schema', sql: initialSchema },
	{ version: 2, name: 'owner-requests', sql: ownerRequests }
];
