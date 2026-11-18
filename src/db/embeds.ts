/**
 * `embed_types` and `embeds` (migration 027).
 *
 * Two tables and one rule between them: a type is the *look*, an embed is one
 * thing shown. This layer stores and reads them and interprets neither — `spec`
 * and `data` are opaque JSON text here, and what is a legal spec is
 * `$domain/embeds.ts`'s question, because it is the same question the renderer
 * asks and there should be one answer.
 *
 * `author` is the literal `human` or `agent:<agent_id>`, exactly as
 * `messages.author` is (design §3), and this layer does not read it either.
 */
import type { Db } from './connection';
import { newId } from './ids';
import type { Embed, EmbedType } from './types';

type TypeRow = {
	seq: number;
	id: string;
	slug: string;
	name: string;
	agent_id: string | null;
	spec: string;
	created_at: number;
	updated_at: number;
};

const TYPE_COLUMNS = `seq, id, slug, name, agent_id, spec, created_at, updated_at`;

function toEmbedType(row: TypeRow): EmbedType {
	return {
		seq: row.seq,
		id: row.id,
		slug: row.slug,
		name: row.name,
		agentId: row.agent_id,
		spec: row.spec,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

type EmbedRow = {
	seq: number;
	id: string;
	type_id: string;
	update_id: string | null;
	message_id: string | null;
	request_id: string | null;
	task_id: string | null;
	agent_id: string | null;
	author: string;
	data: string;
	source_url: string | null;
	created_at: number;
};

const EMBED_COLUMNS = `seq, id, type_id, update_id, message_id, request_id, task_id, agent_id,
	author, data, source_url, created_at`;

function toEmbed(row: EmbedRow): Embed {
	return {
		seq: row.seq,
		id: row.id,
		typeId: row.type_id,
		updateId: row.update_id,
		messageId: row.message_id,
		requestId: row.request_id,
		taskId: row.task_id,
		agentId: row.agent_id,
		author: row.author,
		data: row.data,
		sourceUrl: row.source_url,
		createdAt: row.created_at
	};
}

export function findEmbedTypeBySlug(db: Db, slug: string): EmbedType | undefined {
	const row = db
		.prepare<[string], TypeRow>(`SELECT ${TYPE_COLUMNS} FROM embed_types WHERE slug = ?`)
		.get(slug);
	return row && toEmbedType(row);
}

export function findEmbedTypeById(db: Db, id: string): EmbedType | undefined {
	const row = db
		.prepare<[string], TypeRow>(`SELECT ${TYPE_COLUMNS} FROM embed_types WHERE id = ?`)
		.get(id);
	return row && toEmbedType(row);
}

/** Every registered look, built-ins first and then by name: the order a list reads in. */
export function listEmbedTypes(db: Db): EmbedType[] {
	return db
		.prepare<[], TypeRow>(
			`SELECT ${TYPE_COLUMNS} FROM embed_types
			  ORDER BY agent_id IS NOT NULL, name COLLATE NOCASE, slug`
		)
		.all()
		.map(toEmbedType);
}

export type NewEmbedType = {
	slug: string;
	name: string;
	/** The registering agent, or `null` for one this deployment ships. */
	agentId: string | null;
	/** The spec as JSON text. Already validated by the caller. */
	spec: string;
	at?: number;
};

/**
 * Register a look, or replace the one that slug already names.
 *
 * An upsert rather than an insert because registering is how an agent *starts*:
 * it runs the same call every session, and a second run must leave the same one
 * row rather than fail. `created_at` survives the update — the type was
 * registered once, however many times it has been corrected since.
 *
 * Ownership is not decided here. The domain refuses the write when the existing
 * row belongs to somebody else, because "somebody else" is a rule about agents
 * and this layer knows nothing about them.
 */
export function upsertEmbedType(db: Db, input: NewEmbedType): EmbedType {
	const now = input.at ?? Date.now();
	const row = {
		id: newId(),
		slug: input.slug,
		name: input.name,
		agent_id: input.agentId,
		spec: input.spec,
		created_at: now,
		updated_at: now
	};

	const written = db
		.prepare<typeof row, TypeRow>(
			`INSERT INTO embed_types (id, slug, name, agent_id, spec, created_at, updated_at)
			 VALUES (:id, :slug, :name, :agent_id, :spec, :created_at, :updated_at)
			 ON CONFLICT (slug) DO UPDATE SET
				name = excluded.name,
				spec = excluded.spec,
				updated_at = excluded.updated_at
			 RETURNING ${TYPE_COLUMNS}`
		)
		.get(row)!;

	return toEmbedType(written);
}

export type NewEmbed = {
	typeId: string;
	/** Exactly one of the four cards this is on (migration 030). */
	updateId?: string | null;
	messageId?: string | null;
	requestId?: string | null;
	taskId?: string | null;
	agentId?: string | null;
	author: string;
	/** The values, as JSON text. Already validated by the caller. */
	data: string;
	sourceUrl?: string | null;
	at?: number;
};

export function insertEmbed(db: Db, input: NewEmbed): Embed {
	const row = {
		id: newId(),
		type_id: input.typeId,
		update_id: input.updateId ?? null,
		message_id: input.messageId ?? null,
		request_id: input.requestId ?? null,
		task_id: input.taskId ?? null,
		agent_id: input.agentId ?? null,
		author: input.author,
		data: input.data,
		source_url: input.sourceUrl ?? null,
		created_at: input.at ?? Date.now()
	};

	const written = db
		.prepare<typeof row, EmbedRow>(
			`INSERT INTO embeds
				(id, type_id, update_id, message_id, request_id, task_id, agent_id, author, data,
				 source_url, created_at)
			 VALUES
				(:id, :type_id, :update_id, :message_id, :request_id, :task_id, :agent_id, :author,
				 :data, :source_url, :created_at)
			 RETURNING ${EMBED_COLUMNS}`
		)
		.get(row)!;

	return toEmbed(written);
}

/** Which card an embed hangs off (migration 030). */
export type EmbedAnchor = 'update_id' | 'message_id' | 'request_id' | 'task_id';

/**
 * One card's embeds, oldest first: the order the poster listed them in.
 *
 * One reader for all four anchors rather than four that differ only in a column
 * name — the owner's "all card types support all the same things" is easier to
 * keep true when there is one place it could stop being true.
 */
function listEmbedsFor(db: Db, anchor: EmbedAnchor, cardId: string): Embed[] {
	return db
		.prepare<[string], EmbedRow>(
			`SELECT ${EMBED_COLUMNS} FROM embeds WHERE ${anchor} = ? ORDER BY seq`
		)
		.all(cardId)
		.map(toEmbed);
}

export function listEmbedsForUpdate(db: Db, updateId: string): Embed[] {
	return listEmbedsFor(db, 'update_id', updateId);
}

export function listEmbedsForMessage(db: Db, messageId: string): Embed[] {
	return listEmbedsFor(db, 'message_id', messageId);
}

/** An approval's embeds (migration 030). */
export function listEmbedsForRequest(db: Db, requestId: string): Embed[] {
	return listEmbedsFor(db, 'request_id', requestId);
}

/** A task's embeds (migration 030). */
export function listEmbedsForTask(db: Db, taskId: string): Embed[] {
	return listEmbedsFor(db, 'task_id', taskId);
}
