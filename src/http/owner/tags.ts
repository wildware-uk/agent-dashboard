/**
 * The owner's writes on a project's vocabulary (migration 039).
 *
 * The owner: "allow users and agents to define tags for a project, ie 'feature,
 * bug, high priority' etc."
 *
 * Defining, renaming and retiring live here; putting a word *on* a card is a
 * card action and lives with the others (`./cards.ts`), because it is the same
 * act whichever kind of card it lands on.
 */
import { defineTag, listTags, renameTag, retireTag } from '$domain';
import { invalid } from '$domain/errors';
import { ownerAction, readOwnerJson, type OwnerHandler, type OwnerHandlerOptions } from './actions';

/** `GET /api/projects/[reference]/tags` — a project's words, oldest first. */
export function listTagsHandler(options: OwnerHandlerOptions = {}): OwnerHandler {
	return ownerAction(options, (event, ctx) =>
		Promise.resolve({
			status: 200,
			body: { tags: listTags(ctx, { project: event.params.reference ?? '' }) }
		})
	);
}

/**
 * `POST /api/projects/[reference]/tags` — decide a word for this project.
 *
 * Idempotent on the word: defining "bug" twice hands back the same tag rather
 * than refusing, so a second tab and a racing agent cannot make this fail.
 */
export function defineTagHandler(options: OwnerHandlerOptions = {}): OwnerHandler {
	return ownerAction(options, async (event, ctx) => {
		const body = (await readOwnerJson(event.request).catch(() => ({}))) as {
			name?: unknown;
			colour?: unknown;
		};
		if (typeof body.name !== 'string') throw invalid('name must be a string');
		if (body.colour !== undefined && body.colour !== null && typeof body.colour !== 'string') {
			throw invalid('colour must be a palette name, or null');
		}

		const tag = defineTag(ctx, {
			project: event.params.reference ?? '',
			name: body.name,
			...(body.colour === undefined ? {} : { colour: body.colour })
		});

		return { status: 200, body: { tag } };
	});
}

/** `PATCH /api/tags/[id]` — rename a word, or recolour it, everywhere at once. */
export function renameTagHandler(options: OwnerHandlerOptions = {}): OwnerHandler {
	return ownerAction(options, async (event, ctx) => {
		const body = (await readOwnerJson(event.request).catch(() => ({}))) as {
			name?: unknown;
			colour?: unknown;
		};
		if (body.name !== undefined && typeof body.name !== 'string') {
			throw invalid('name must be a string');
		}
		if (body.colour !== undefined && body.colour !== null && typeof body.colour !== 'string') {
			throw invalid('colour must be a palette name, or null');
		}

		const tag = renameTag(ctx, event.params.id ?? '', {
			...(body.name === undefined ? {} : { name: body.name }),
			...(body.colour === undefined ? {} : { colour: body.colour })
		});

		return { status: 200, body: { tag } };
	});
}

/**
 * `DELETE /api/tags/[id]` — retire a word, taking it off every card.
 *
 * A real delete: a word the project has abandoned should stop being offered and
 * stop being worn. The cards keep everything else they carry.
 */
export function retireTagHandler(options: OwnerHandlerOptions = {}): OwnerHandler {
	return ownerAction(options, (event, ctx) =>
		Promise.resolve({ status: 200, body: { tag: retireTag(ctx, event.params.id ?? '') } })
	);
}
