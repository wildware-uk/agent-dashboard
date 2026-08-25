/**
 * Projects (design §3, §5).
 *
 * The template every later domain module copies: `ctx` first, then plain
 * arguments; plain objects out; a `DomainError` for anything the caller could
 * have avoided; and **exactly one event published per write**, after the write
 * has landed.
 */
import {
	findProjectById,
	findProjectBySlug,
	insertProject,
	isId,
	listProjects as listProjectRows,
	updateProject as patchProject,
	type Project,
	type ProjectStatus
} from '$db';
import type { DomainContext } from './context';
import { conflict, invalid, notFound } from './errors';
import { assertSlug, slugFor } from './slug';
import { optionalText, requiredText } from './text';

export const NAME_MAX_LENGTH = 200;
export const DESCRIPTION_MAX_LENGTH = 2_000;

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
		updatedAt: number;
	} = { updatedAt: ctx.now() };

	if (input.name !== undefined) patch.name = requiredText(input.name, 'name', NAME_MAX_LENGTH);
	if (input.description !== undefined) {
		patch.description = optionalText(input.description, 'description', DESCRIPTION_MAX_LENGTH);
	}
	if (input.status !== undefined) patch.status = input.status;
	if (input.pinned !== undefined) patch.pinned = input.pinned;
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
