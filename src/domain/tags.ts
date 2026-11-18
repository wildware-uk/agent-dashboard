/**
 * A project's own words (migration 039).
 *
 * The owner: "allow users and agents to define tags for a project, ie 'feature,
 * bug, high priority' etc, and these can be included on feed posts by agents and
 * users in one click."
 *
 * Two acts, kept apart because they happen at different moments: **defining** a
 * word for a project, which somebody does once, and **putting** one on a card,
 * which is a click. Everything else here follows from that split.
 *
 * ## Whose words they are
 *
 * The project's, not the definer's. An agent may define one and the owner may
 * use it, and the other way round — a vocabulary only its author could use would
 * be a private note rather than a shared label. What is recorded is who defined
 * it and who put it where, because that is worth knowing and costs one column.
 *
 * ## A card may only wear its own project's words
 *
 * Enforced here, where both the card and the tag are resolved: the schema cannot
 * express it, and a "bug" from another project appearing on this one's card
 * would be a word the picker never offered and nobody can take off.
 */
import {
	addCardTag,
	deleteTag as deleteTagRow,
	findCardTag,
	findTagById,
	findTagBySlug,
	insertTag,
	listCardTags,
	listTags as listTagRows,
	removeCardTag,
	updateTag as updateTagRow,
	type CardRef,
	type CardTag,
	type Tag
} from '$db';
import { announceCard, resolveCard } from './cards';
import type { DomainContext } from './context';
import { invalid, notFound } from './errors';
import { authorText, type MessageAuthor } from './messages';
import { resolveProject } from './projects';

export type { CardTag, Tag };

/** The longest a tag may be. Long enough for "needs design review". */
export const TAG_MAX_LENGTH = 32;

/** How many words one project may have before the picker stops being a picker. */
export const TAGS_PER_PROJECT = 50;

/** How many tags one card may carry. A card wearing twelve says nothing. */
export const TAGS_PER_CARD = 8;

/**
 * The colours a tag may take.
 *
 * Names rather than values, because the dashboard has two themes and a stored
 * hex would be legible in exactly one of them. `null` is the default grey, which
 * is what most tags should be — a palette where everything shouts is one where
 * nothing does.
 */
export const TAG_COLOURS = ['grey', 'rose', 'amber', 'green', 'blue', 'violet'] as const;

export type TagColour = (typeof TAG_COLOURS)[number];

export function isTagColour(value: unknown): value is TagColour {
	return typeof value === 'string' && (TAG_COLOURS as readonly string[]).includes(value);
}

/**
 * The form a word is compared in: trimmed, lowercased, spaces to hyphens.
 *
 * So "Bug", "bug" and " BUG " are one tag rather than three that look identical
 * in a picker. What is *shown* is whatever the definer typed.
 */
export function tagSlug(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/\s+/g, '-')
		.replace(/[^a-z0-9-]/g, '')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');
}

export type DefineTagInput = {
	/** A project slug or id. */
	project: string;
	name: string;
	colour?: string | null;
	/** The agent defining it, or omitted for the owner. */
	agentId?: string | null;
};

/**
 * Define a word for a project, or hand back the one already defined.
 *
 * Idempotent on the normalised word, so two agents deciding a project needs
 * "bug" at the same moment end with one tag and no error anybody has to handle.
 *
 * @throws {DomainError} `not_found` for an unknown project, `invalid_argument`
 *   for a word that is empty, too long, or nothing but punctuation, for a colour
 *   outside the palette, or when the project already has as many words as a
 *   picker can usefully show.
 */
export function defineTag(ctx: DomainContext, input: DefineTagInput): Tag {
	const project = resolveProject(ctx, input.project);
	const name = input.name.trim();

	if (name === '') throw invalid('a tag needs a word');
	if (name.length > TAG_MAX_LENGTH) {
		throw invalid(`a tag may be at most ${TAG_MAX_LENGTH} characters`);
	}

	const slug = tagSlug(name);
	if (slug === '') throw invalid(`${JSON.stringify(input.name)} has no letters or digits in it`);

	if (input.colour != null && !isTagColour(input.colour)) {
		throw invalid(`colour must be one of ${TAG_COLOURS.join(', ')}`);
	}

	const existing = findTagBySlug(ctx.db, project.id, slug);
	if (existing) return existing;

	if (listTagRows(ctx.db, [project.id]).length >= TAGS_PER_PROJECT) {
		throw invalid(
			`this project already has ${TAGS_PER_PROJECT} tags, which is as many as a picker can show`
		);
	}

	const tag = insertTag(ctx.db, {
		projectId: project.id,
		name,
		slug,
		colour: input.colour ?? null,
		agentId: input.agentId ?? null,
		createdAt: ctx.now()
	});

	ctx.bus.publish('tags.changed', { projectId: project.id });
	return tag;
}

/** A project's vocabulary, or every project's when none is named. */
export function listTags(ctx: DomainContext, query: { project?: string | null } = {}): Tag[] {
	const projectIds = query.project ? [resolveProject(ctx, query.project).id] : undefined;
	return listTagRows(ctx.db, projectIds);
}

/**
 * Rename a tag, or recolour it.
 *
 * The word moves on every card carrying it, which is the point of storing the
 * tag once: correcting "Buig" should not mean visiting nine cards.
 *
 * @throws {DomainError} `not_found` for an unknown tag, `invalid_argument` for a
 *   word that is empty or too long, a colour outside the palette, or a rename
 *   onto a word the project already has.
 */
export function renameTag(
	ctx: DomainContext,
	id: string,
	patch: { name?: string; colour?: string | null }
): Tag {
	const tag = findTagById(ctx.db, id);
	if (!tag) throw notFound(`no such tag: ${id}`);

	if (patch.colour != null && !isTagColour(patch.colour)) {
		throw invalid(`colour must be one of ${TAG_COLOURS.join(', ')}`);
	}

	let name: string | undefined;
	let slug: string | undefined;
	if (patch.name !== undefined) {
		name = patch.name.trim();
		if (name === '') throw invalid('a tag needs a word');
		if (name.length > TAG_MAX_LENGTH) {
			throw invalid(`a tag may be at most ${TAG_MAX_LENGTH} characters`);
		}
		slug = tagSlug(name);
		if (slug === '') throw invalid(`${JSON.stringify(patch.name)} has no letters or digits in it`);

		const clash = findTagBySlug(ctx.db, tag.projectId, slug);
		if (clash && clash.id !== tag.id) {
			throw invalid(`this project already has a tag called ${JSON.stringify(clash.name)}`);
		}
	}

	const saved = updateTagRow(ctx.db, id, {
		...(name === undefined ? {} : { name, slug: slug! }),
		...(patch.colour === undefined ? {} : { colour: patch.colour })
	})!;

	ctx.bus.publish('tags.changed', { projectId: tag.projectId });
	return saved;
}

/**
 * Retire a tag, taking it off every card at once.
 *
 * Deliberately not a soft delete: a word the project has abandoned should stop
 * being offered *and* stop being worn, and a card labelled with something nobody
 * can explain is worse than one with no label. The cards keep everything else.
 *
 * @throws {DomainError} `not_found` for a tag that is not there.
 */
export function retireTag(ctx: DomainContext, id: string): { id: string; projectId: string } {
	const tag = findTagById(ctx.db, id);
	if (!tag) throw notFound(`no such tag: ${id}`);

	deleteTagRow(ctx.db, id);
	ctx.bus.publish('tags.changed', { projectId: tag.projectId });
	return { id, projectId: tag.projectId };
}

export type TagCardInput = {
	card: CardRef;
	/** The tag's id, or its word — a picker sends the id, a tool sends the word. */
	tag: string;
	/** From the session cookie or the bearer token, never an argument (§5). */
	actor: MessageAuthor;
	/**
	 * `true` to put it on, `false` to take it off, omitted to toggle.
	 *
	 * Toggling is what a click means. A caller that knows which it wants says so:
	 * a retry after a dropped connection would otherwise undo itself.
	 */
	on?: boolean;
	/**
	 * Define the word if the project does not have it yet.
	 *
	 * What makes "one click" true for an agent: `tag_card({ tags: ['bug'] })`
	 * should work on a project that has not got round to defining "bug". The
	 * owner's picker passes an id and never needs this.
	 */
	create?: boolean;
};

export type TagCardResult = { card: CardRef; tag: Tag; on: boolean };

/**
 * Put one of a project's words on a card, or take it off.
 *
 * @throws {DomainError} `not_found` for an unknown or deleted card, or a tag
 *   this project has not defined; `invalid_argument` for a tag belonging to
 *   another project, or a card already carrying as many as it can wear.
 */
export function tagCard(ctx: DomainContext, input: TagCardInput): TagCardResult {
	const row = resolveCard(ctx, input.card);
	const projectId = row.projectId;
	if (!projectId) throw invalid('this card does not belong to a project, so it cannot be tagged');

	const tag = resolveTag(ctx, projectId, input.tag, input.create === true, input.actor);

	const already = findCardTag(ctx.db, input.card, tag.id);
	const wanted = input.on ?? already === undefined;

	if (wanted === (already !== undefined)) {
		// Nothing to do, and nothing to announce: a second click that agrees with
		// the state is the same state.
		return { card: input.card, tag, on: wanted };
	}

	if (wanted) {
		const worn = listCardTags(ctx.db, { [input.card.kind]: [input.card.id] });
		if (worn.length >= TAGS_PER_CARD) {
			throw invalid(`a card may carry at most ${TAGS_PER_CARD} tags`);
		}
		addCardTag(ctx.db, {
			card: input.card,
			tagId: tag.id,
			author: authorText(input.actor),
			createdAt: ctx.now()
		});
	} else {
		removeCardTag(ctx.db, input.card, tag.id);
	}

	// Two events, deliberately. The card's own, so the store that renders that
	// kind redraws it — and `tags.changed`, because *which cards wear which* is
	// carried by the feed's snapshot rather than by the card row, and the feed
	// does not watch message or request events. Without the second one, labelling
	// one of the owner's own posts landed in the database and nowhere on screen.
	announceCard(ctx, input.card, row);
	ctx.bus.publish('tags.changed', { projectId });

	return { card: input.card, tag, on: wanted };
}

/** The tag a caller named: by id, or by word in this project. */
function resolveTag(
	ctx: DomainContext,
	projectId: string,
	named: string,
	create: boolean,
	actor: MessageAuthor
): Tag {
	const byId = findTagById(ctx.db, named);
	if (byId) {
		if (byId.projectId !== projectId) {
			throw invalid('that tag belongs to another project');
		}
		return byId;
	}

	const slug = tagSlug(named);
	const byWord = slug === '' ? undefined : findTagBySlug(ctx.db, projectId, slug);
	if (byWord) return byWord;

	if (!create) throw notFound(`this project has no tag called ${JSON.stringify(named)}`);
	// Defined by whoever is tagging: an agent inventing a word for a project
	// should be on the record as having invented it.
	return defineTag(ctx, {
		project: projectId,
		name: named,
		...(actor.kind === 'agent' ? { agentId: actor.agentId } : {})
	});
}

/** Which cards to read tags for, by kind. */
export type TagScope = Partial<Record<CardRef['kind'], readonly string[]>>;

/** Every tag on these cards, for a page of the feed. */
export function tagsForCards(ctx: DomainContext, scope: TagScope): CardTag[] {
	return listCardTags(ctx.db, scope);
}
