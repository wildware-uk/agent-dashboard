/**
 * Projects (design §3, §5).
 *
 * The template every later domain module copies: `ctx` first, then plain
 * arguments; plain objects out; a `DomainError` for anything the caller could
 * have avoided; and **exactly one event published per write**, after the write
 * has landed.
 */
import {
	countUnseenUpdates,
	findProjectById,
	findProjectBySlug,
	insertProject,
	isId,
	markProjectSeen as markProjectSeenRow,
	listProjects as listProjectRows,
	updateProject as patchProject,
	findMediaById,
	type BoardColumn,
	type Project,
	type ProjectBoard,
	type ProjectStatus,
	type ProjectTheme,
	type TaskState
} from '$db';
import type { DomainContext } from './context';
import { conflict, invalid, notFound } from './errors';
import { assertSlug, slugFor } from './slug';
import { optionalText, requiredText } from './text';

export const NAME_MAX_LENGTH = 200;
export const DESCRIPTION_MAX_LENGTH = 2_000;

/**
 * What a theme colour may be, and nothing else (design §7, §8).
 *
 * **This pattern is a security boundary, not a formatting preference.** These
 * values are written into a CSS custom property on the owner's dashboard, and
 * agents can set them — so anything that is not a hex literal is refused here
 * rather than escaped later. `red` would work; `var(--x)`, `url(…)`, a closing
 * brace or a semicolon would each be a way to write CSS the owner did not ask
 * for, and allowing the readable names would mean maintaining a list of which
 * words are safe. One shape, checked once.
 */
export const THEME_COLOUR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * The board every project has until its owner says otherwise (design §7).
 *
 * Three columns, because that is the shape of the work: waiting, being done,
 * over. `cancelled` is deliberately absent — a cancelled task is not a lane
 * somebody works through, and a column for it would be a permanent reminder of
 * everything that was ever called off.
 */
export const DEFAULT_BOARD: ProjectBoard = {
	columns: [
		{ title: 'To do', states: ['todo'] },
		{ title: 'In progress', states: ['claimed'] },
		{ title: 'Done', states: ['done'] }
	]
};

/** How many columns is still a board rather than a spreadsheet. */
export const BOARD_COLUMNS_MAX = 6;
export const COLUMN_TITLE_MAX_LENGTH = 40;

/** The states a column may gather. `cancelled` is allowed, just not by default. */
const TASK_STATES: readonly TaskState[] = ['todo', 'claimed', 'done', 'cancelled'];

/**
 * A board, checked.
 *
 * The rule worth stating is that **no state may appear in two columns**. A task
 * is in exactly one place on a board; a state claimed twice would draw the same
 * task in two lanes, and an owner moving it out of one would find it still in
 * the other. A column with no states at all is refused for the opposite reason:
 * it is a lane nothing can ever be in.
 *
 * @throws {DomainError} `invalid_argument`, naming what was wrong with it.
 */
export function assertBoard(input: unknown): ProjectBoard | null {
	if (input === null || input === undefined) return null;
	if (typeof input !== 'object' || Array.isArray(input)) {
		throw invalid('board must be an object, or null for the default columns');
	}

	const columns = (input as { columns?: unknown }).columns;
	if (!Array.isArray(columns)) throw invalid('board.columns must be a list');
	if (columns.length === 0) throw invalid('a board needs at least one column');
	if (columns.length > BOARD_COLUMNS_MAX) {
		throw invalid(`at most ${BOARD_COLUMNS_MAX} columns`);
	}

	const seen = new Set<string>();
	const checked: BoardColumn[] = columns.map((column, index) => {
		if (column === null || typeof column !== 'object' || Array.isArray(column)) {
			throw invalid(`columns[${index}] must be an object`);
		}

		const { title, states } = column as { title?: unknown; states?: unknown };
		if (!Array.isArray(states) || states.length === 0) {
			throw invalid(`columns[${index}].states must name at least one task state`);
		}

		for (const state of states) {
			if (typeof state !== 'string' || !TASK_STATES.includes(state as TaskState)) {
				throw invalid(`columns[${index}].states must be any of: ${TASK_STATES.join(', ')}`);
			}
			if (seen.has(state)) {
				throw invalid(`${state} is already in another column`);
			}
			seen.add(state);
		}

		return {
			title: requiredText(String(title ?? ''), `columns[${index}].title`, COLUMN_TITLE_MAX_LENGTH),
			states: states as TaskState[]
		};
	});

	return { columns: checked };
}

/** What a caller may set. Each field `null` clears that one; see {@link mergeTheme}. */
export type ProjectThemeInput = {
	background?: string | null;
	accent?: string | null;
	logoMediaId?: string | null;
	/** True to show the logo instead of the name; `null` or false to show both. */
	logoReplacesName?: boolean | null;
};

export type CreateProjectInput = {
	name: string;
	description?: string | null;
	/** Defaults to a slug derived from `name`. */
	slug?: string | null;
};

/**
 * The result of a create that may not have created anything.
 *
 * `created` is what makes idempotency observable: an adapter can report "already
 * exists" without a second lookup, and a UI can decide whether to animate.
 */
export type CreateProjectResult = { project: Project; created: boolean };

/**
 * Create a project, or hand back the one that already owns the slug.
 *
 * Idempotent on slug (design §5): an agent that re-runs its bootstrap should get
 * its project, not an error it has to special-case. The existing row is returned
 * untouched — a create is not a covert update — and nothing is published,
 * because nothing was written.
 *
 * The read-then-insert is safe without a transaction: the SQLite driver is
 * synchronous and this deployment is a single process (design §2), so no other
 * writer can interleave between the two statements.
 */
export function createProject(ctx: DomainContext, input: CreateProjectInput): CreateProjectResult {
	const name = requiredText(input.name, 'name', NAME_MAX_LENGTH);
	const slug = slugFor(name, input.slug);
	const description = optionalText(input.description, 'description', DESCRIPTION_MAX_LENGTH);

	const existing = findProjectBySlug(ctx.db, slug);
	if (existing) return { project: existing, created: false };

	const project = insertProject(ctx.db, {
		slug,
		name,
		description,
		createdAt: ctx.now()
	});
	ctx.bus.publish('project.created', { projectId: project.id, slug: project.slug });

	return { project, created: true };
}

/** Every project in sidebar order: pinned first, then newest (design §7). */
export function listProjects(
	ctx: DomainContext,
	filter: { status?: ProjectStatus } = {}
): Project[] {
	return listProjectRows(ctx.db, filter);
}

/**
 * Look up a project by the reference an agent gave us, which may be a slug or an
 * id (design §5).
 *
 * Both are tried either way round: a slug of 26 digits is a legal ULID shape, so
 * "looks like an id" is a hint about which lookup to run first, never a verdict.
 *
 * @returns the project, or `undefined` if nothing matches.
 * @throws {DomainError} `invalid_argument` if the reference is blank.
 */
export function findProject(ctx: DomainContext, reference: string): Project | undefined {
	const ref = reference.trim();
	if (ref === '') throw invalid('project is required');

	if (isId(ref)) {
		return findProjectById(ctx.db, ref) ?? findProjectBySlug(ctx.db, ref.toLowerCase());
	}
	return findProjectBySlug(ctx.db, ref.toLowerCase()) ?? findProjectById(ctx.db, ref);
}

/** {@link findProject}, for callers that cannot continue without one. */
export function resolveProject(ctx: DomainContext, reference: string): Project {
	const project = findProject(ctx, reference);
	if (!project) throw notFound(`no such project: ${reference.trim()}`);
	return project;
}

export type UpdateProjectInput = {
	name?: string;
	description?: string | null;
	slug?: string;
	status?: ProjectStatus;
	pinned?: boolean;
	/**
	 * Per-project styling (design §7).
	 *
	 * Merged field by field with whatever the project already has, so setting an
	 * accent does not silently drop a logo. `null` clears the whole theme.
	 */
	theme?: ProjectThemeInput | null;
	/**
	 * The task board's columns (design §7).
	 *
	 * Replaced wholesale rather than merged, unlike the theme: a board is an
	 * ordered list, and "merge" has no meaning for one — the caller is always
	 * sending the arrangement they want. `null` restores the default three.
	 */
	board?: unknown;
};

/**
 * Change the fields named, leave the rest alone, publish once.
 *
 * An empty patch is refused rather than treated as a no-op: it would otherwise
 * bump `updated_at` and publish a `project.updated` that told every connected
 * browser to re-render for nothing.
 */
export function updateProject(
	ctx: DomainContext,
	reference: string,
	input: UpdateProjectInput
): Project {
	const project = resolveProject(ctx, reference);
	const patch: {
		name?: string;
		description?: string | null;
		slug?: string;
		status?: ProjectStatus;
		pinned?: boolean;
		theme?: ProjectTheme | null;
		board?: ProjectBoard | null;
		updatedAt: number;
	} = { updatedAt: ctx.now() };

	if (input.name !== undefined) patch.name = requiredText(input.name, 'name', NAME_MAX_LENGTH);
	if (input.description !== undefined) {
		patch.description = optionalText(input.description, 'description', DESCRIPTION_MAX_LENGTH);
	}
	if (input.status !== undefined) patch.status = input.status;
	if (input.pinned !== undefined) patch.pinned = input.pinned;
	if (input.theme !== undefined) {
		patch.theme = input.theme === null ? null : mergeTheme(ctx, project.theme, input.theme);
	}
	if (input.board !== undefined) patch.board = assertBoard(input.board);
	if (input.slug !== undefined) {
		const slug = assertSlug(input.slug);
		const holder = findProjectBySlug(ctx.db, slug);
		if (holder && holder.id !== project.id) {
			throw conflict(`slug already in use: ${slug}`);
		}
		patch.slug = slug;
	}

	if (Object.keys(patch).length === 1) {
		throw invalid('update requires at least one field to change');
	}

	// The row was just resolved and nothing else can write between the two
	// statements, so a missing row here would be a bug, not a race.
	const updated = patchProject(ctx.db, project.id, patch)!;
	ctx.bus.publish('project.updated', { projectId: updated.id, slug: updated.slug });

	return updated;
}

/**
 * Fold a theme patch into the theme a project already has.
 *
 * Field by field, because the two callers set different things: the owner picks
 * colours in the browser, an agent that just uploaded an image sets a logo, and
 * neither should wipe the other's work by not mentioning it. A field explicitly
 * `null` is a clear; a field absent is "leave it".
 *
 * A theme with nothing left in it becomes `null` rather than `{}` — an empty
 * object would be a project that says it is themed and looks exactly like one
 * that is not.
 *
 * @throws {DomainError} `invalid_argument` for a colour that is not a hex
 *   literal, or a logo that is not a ready image; `not_found` for a logo id with
 *   no media row.
 */
export function mergeTheme(
	ctx: DomainContext,
	current: ProjectTheme | null,
	input: ProjectThemeInput
): ProjectTheme | null {
	const theme: ProjectTheme = { ...(current ?? {}) };

	if (input.background !== undefined) {
		if (input.background === null) delete theme.background;
		else theme.background = assertColour(input.background, 'background');
	}
	if (input.accent !== undefined) {
		if (input.accent === null) delete theme.accent;
		else theme.accent = assertColour(input.accent, 'accent');
	}
	if (input.logoMediaId !== undefined) {
		if (input.logoMediaId === null) {
			delete theme.logoMediaId;
			// A logo that is not there cannot replace anything, and leaving the flag
			// set would make the header render a name-shaped hole the next time one
			// is chosen.
			delete theme.logoReplacesName;
		} else {
			theme.logoMediaId = assertLogo(ctx, input.logoMediaId);
		}
	}
	if (input.logoReplacesName !== undefined) {
		if (typeof input.logoReplacesName !== 'boolean' && input.logoReplacesName !== null) {
			throw invalid('logoReplacesName is true or false');
		}
		// Stored only when true: false is the default, and a stored `false` would be
		// a theme that exists to say nothing.
		if (input.logoReplacesName) theme.logoReplacesName = true;
		else delete theme.logoReplacesName;
	}

	if (theme.logoReplacesName && !theme.logoMediaId) {
		throw invalid('logoReplacesName needs a logo to show instead of the name');
	}

	return Object.keys(theme).length === 0 ? null : theme;
}

/**
 * A colour, checked and normalised to `#rrggbb`.
 *
 * Normalising matters as much as checking: two spellings of the same colour
 * would otherwise be two different strings in the database and two different
 * values to compare in a test.
 */
function assertColour(value: string, field: string): string {
	const trimmed = value.trim();
	if (!THEME_COLOUR.test(trimmed)) {
		throw invalid(`${field} must be a hex colour like #1a2b3c`);
	}

	const hex = trimmed.slice(1).toLowerCase();
	return `#${hex.length === 3 ? [...hex].map((digit) => digit + digit).join('') : hex}`;
}

/**
 * A logo, checked.
 *
 * It has to be a ready image: a `pending` id would render as a broken box in the
 * header until the pipeline caught up, and a video has no still to show. Media
 * is uploaded by agents (§6), so this is also the path by which an agent brands
 * its own project — it uploads through `create_upload` and names the id here.
 */
function assertLogo(ctx: DomainContext, mediaId: string): string {
	const media = findMediaById(ctx.db, mediaId);
	if (!media) throw notFound(`no such media: ${mediaId}`);
	if (media.kind !== 'image') throw invalid('a logo must be an image');
	if (media.status !== 'ready') throw invalid('that image is still being processed');
	return media.id;
}

/**
 * Record that the owner has looked at a project, so its "new" badge clears.
 *
 * Stamped server-side rather than remembered per browser, because there is one
 * owner and more than one screen: a badge that cleared on the phone and stayed
 * lit on the desk would be worse than no badge at all.
 *
 * It publishes `project.updated` even though it changes nothing anybody can see
 * on the project itself — a second tab is showing the same sidebar, and a badge
 * that only cleared in the window that cleared it is the same inconsistency in a
 * smaller box. It deliberately does **not** bump `updated_at` (`src/db/projects.ts`):
 * reading a page is not editing it, and a project that sorted as freshly changed
 * because somebody glanced at it would be a lie.
 *
 * @throws {DomainError} `not_found` for a project reference that matches nothing.
 */
export function markProjectSeen(ctx: DomainContext, reference: string): Project {
	const project = resolveProject(ctx, reference);
	const seen = markProjectSeenRow(ctx.db, project.id, ctx.now())!;

	ctx.bus.publish('project.updated', { projectId: seen.id, slug: seen.slug });
	return seen;
}

/**
 * How many updates have landed in each project since the owner last opened it.
 *
 * Owner-facing only, and kept out of {@link listProjects} for that reason: an
 * agent calling `list_projects` has no business learning what its owner has and
 * has not read, and a field that leaked there would be on the MCP wire for ever.
 *
 * Projects with nothing new are absent rather than zero, because the caller
 * renders a badge per entry and `0` would be a badge saying nothing happened.
 */
export function unseenUpdateCounts(ctx: DomainContext): Record<string, number> {
	return countUnseenUpdates(ctx.db);
}
