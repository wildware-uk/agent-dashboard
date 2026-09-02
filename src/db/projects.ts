/**
 * `projects` (design §3).
 *
 * Plain SQL. Whether a slug may be reused, or what archiving means for the
 * agents posting into a project, is the domain's problem.
 */
import type { Db } from './connection';
import { newId } from './ids';
import { boolOf, flagOf, jsonOf, jsonText, orNull } from './rows';
import type { Project, ProjectBoard, ProjectStatus, ProjectTheme } from './types';

type Row = {
	seq: number;
	id: string;
	slug: string;
	name: string;
	description: string | null;
	status: ProjectStatus;
	pinned: number;
	created_at: number;
	updated_at: number;
	theme: string | null;
	board: string | null;
	owner_seen_at: number | null;
};

const COLUMNS = `seq, id, slug, name, description, status, pinned, created_at, updated_at,
	theme, board, owner_seen_at`;

function toProject(row: Row): Project {
	return {
		seq: row.seq,
		id: row.id,
		slug: row.slug,
		name: row.name,
		description: row.description,
		status: row.status,
		pinned: boolOf(row.pinned),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		theme: jsonOf<ProjectTheme>(row.theme),
		board: jsonOf<ProjectBoard>(row.board),
		ownerSeenAt: row.owner_seen_at
	};
}

export type NewProject = {
	/** Defaults to a fresh ULID. */
	id?: string;
	slug: string;
	name: string;
	description?: string | null;
	status?: ProjectStatus;
	pinned?: boolean;
	/** Defaults to now. */
	createdAt?: number;
	/** Defaults to `createdAt`. */
	updatedAt?: number;
};

/** Insert a project and return it as stored. Throws on a duplicate slug. */
export function insertProject(db: Db, input: NewProject): Project {
	const now = Date.now();
	const createdAt = input.createdAt ?? now;
	const row = {
		id: input.id ?? newId(),
		slug: input.slug,
		name: input.name,
		description: orNull(input.description),
		status: input.status ?? 'active',
		pinned: flagOf(input.pinned ?? false),
		created_at: createdAt,
		updated_at: input.updatedAt ?? createdAt
	};

	const inserted = db
		.prepare<typeof row, Row>(
			`INSERT INTO projects
				(id, slug, name, description, status, pinned, created_at, updated_at)
			 VALUES
				(:id, :slug, :name, :description, :status, :pinned, :created_at, :updated_at)
			 RETURNING ${COLUMNS}`
		)
		.get(row)!;

	return toProject(inserted);
}

export function findProjectById(db: Db, id: string): Project | undefined {
	const row = db.prepare<[string], Row>(`SELECT ${COLUMNS} FROM projects WHERE id = ?`).get(id);
	return row && toProject(row);
}

export function findProjectBySlug(db: Db, slug: string): Project | undefined {
	const row = db.prepare<[string], Row>(`SELECT ${COLUMNS} FROM projects WHERE slug = ?`).get(slug);
	return row && toProject(row);
}

/**
 * Projects in sidebar order: pinned first, then newest.
 *
 * The list is small by construction (one owner, tens of projects), so there is
 * no pagination here.
 */
export function listProjects(db: Db, filter: { status?: ProjectStatus } = {}): Project[] {
	const rows = db
		.prepare<{ status: ProjectStatus | null }, Row>(
			`SELECT ${COLUMNS} FROM projects
			 WHERE (:status IS NULL OR status = :status)
			 ORDER BY pinned DESC, seq DESC`
		)
		.all({ status: orNull(filter.status) });

	return rows.map(toProject);
}

export type ProjectPatch = {
	slug?: string;
	name?: string;
	description?: string | null;
	status?: ProjectStatus;
	pinned?: boolean;
	/** `null` clears the theme entirely, back to the dashboard's own styling. */
	theme?: ProjectTheme | null;
	/** `null` clears the board, back to the default three columns. */
	board?: ProjectBoard | null;
	/** Defaults to now whenever anything else changes. */
	updatedAt?: number;
};

/**
 * Write the fields present in `patch`, leaving the rest alone.
 *
 * @returns the row as it now stands, or `undefined` if there is no such project.
 */
export function updateProject(db: Db, id: string, patch: ProjectPatch): Project | undefined {
	const sets: string[] = [];
	const params: Record<string, string | number | null> = { id };

	const set = (column: string, value: string | number | null) => {
		sets.push(`${column} = :${column}`);
		params[column] = value;
	};

	if (patch.slug !== undefined) set('slug', patch.slug);
	if (patch.name !== undefined) set('name', patch.name);
	if (patch.description !== undefined) set('description', orNull(patch.description));
	if (patch.status !== undefined) set('status', patch.status);
	if (patch.pinned !== undefined) set('pinned', flagOf(patch.pinned));
	if (patch.theme !== undefined) set('theme', jsonText(patch.theme));
	if (patch.board !== undefined) set('board', jsonText(patch.board));
	if (sets.length === 0 && patch.updatedAt === undefined) return findProjectById(db, id);
	set('updated_at', patch.updatedAt ?? Date.now());

	const row = db
		.prepare<typeof params, Row>(
			`UPDATE projects SET ${sets.join(', ')} WHERE id = :id RETURNING ${COLUMNS}`
		)
		.get(params);

	return row && toProject(row);
}

/**
 * Stamp when the owner last opened a project.
 *
 * Deliberately not part of `updateProject`: every other project patch is a
 * change to what the project *is* and bumps `updated_at`, and reading a page is
 * neither. A project would otherwise sort as freshly edited because somebody
 * glanced at it.
 */
export function markProjectSeen(db: Db, id: string, at: number): Project | undefined {
	const row = db
		.prepare<[number, string], Row>(
			`UPDATE projects SET owner_seen_at = ? WHERE id = ? RETURNING ${COLUMNS}`
		)
		.get(at, id);

	return row && toProject(row);
}

/**
 * Updates per project that landed after the owner last looked, newest state of
 * the sidebar badge.
 *
 * One grouped query rather than a count per project: the sidebar asks for all of
 * them at once, on every snapshot, and a query per row would be a fan-out that
 * grows with the number of projects on screen.
 *
 * Deleted updates are excluded — a badge that counted a card the owner can never
 * open would never clear.
 */
export function countUnseenUpdates(db: Db): Record<string, number> {
	const rows = db
		.prepare<[], { project_id: string; count: number }>(
			`SELECT u.project_id AS project_id, COUNT(*) AS count
			   FROM updates u
			   JOIN projects p ON p.id = u.project_id
			  WHERE u.deleted_at IS NULL
			    AND u.created_at > COALESCE(p.owner_seen_at, 0)
			  GROUP BY u.project_id`
		)
		.all();

	return Object.fromEntries(rows.map((row) => [row.project_id, row.count]));
}
