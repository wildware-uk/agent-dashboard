/**
 * What is known about a card, in fields (migration 040).
 *
 * The owner: "allow agents to set metadata on cards, for example, branch name,
 * PR link, anything they like, they are hidden by default, but can be viewed on
 * the dashboard, and updated by the user and agent alike."
 *
 * ## Nobody owns a field
 *
 * The owner may correct an agent's, and an agent may correct the owner's. That
 * is the opposite of editing a message — words belong to whoever said them — and
 * it is right for the same reason work states are shared: a branch name is a
 * fact about the job, not a statement somebody made. What is kept is who touched
 * it last and when, so a wrong value can be traced rather than argued about.
 *
 * ## No types, deliberately
 *
 * A value is text. The temptation is a type per field — a URL, a number, a
 * date — and it buys nothing here: the dashboard renders a link when a value is
 * one and plain text otherwise, and an agent that had to declare a type would
 * have one more thing to get wrong before it could say "the branch is fix/fees".
 */
import {
	deleteCardField,
	findCardField,
	listCardFields,
	upsertCardField,
	type CardField,
	type CardKind,
	type CardRef
} from '$db';
import { announceCard, resolveCard } from './cards';
import type { DomainContext } from './context';
import { invalid, notFound } from './errors';
import { authorText, type MessageAuthor } from './messages';

export type { CardField };

/** The longest a field name may be. Long enough for "deployment environment". */
export const FIELD_NAME_MAX = 40;

/** The longest a value may be. Long enough for a URL and a sentence about it. */
export const FIELD_VALUE_MAX = 500;

/** How many fields one card may carry before the panel stops being readable. */
export const FIELDS_PER_CARD = 20;

/**
 * The form a name is compared in: trimmed, lowercased, spaces to hyphens.
 *
 * So "Branch", "branch" and "BRANCH " are one field. What is *shown* is whatever
 * was typed last, because an agent writing "PR link" should not have its
 * capitals taken away by whoever wrote "pr link" first.
 */
export function fieldSlug(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/\s+/g, '-')
		.replace(/[^a-z0-9._-]/g, '')
		.replace(/-+/g, '-')
		.replace(/^[-.]+|[-.]+$/g, '');
}

export type SetFieldInput = {
	card: CardRef;
	name: string;
	/** What it says, or `null` to take the field off the card. */
	value: string | null;
	/** From the session cookie or the bearer token, never an argument (§5). */
	actor: MessageAuthor;
};

export type SetFieldResult = {
	card: CardRef;
	/** Every field on the card afterwards, so a caller need not ask again. */
	fields: CardField[];
	/** Whether the card ended up carrying this one. */
	set: boolean;
};

/**
 * Set a field on a card, correct it, or take it off.
 *
 * @throws {DomainError} `not_found` for an unknown or deleted card, or for
 *   clearing a field that is not there; `invalid_argument` for a name that is
 *   empty or has nothing but punctuation in it, a name or value past its limit,
 *   or a card already carrying as many fields as it can show.
 */
export function setField(ctx: DomainContext, input: SetFieldInput): SetFieldResult {
	const row = resolveCard(ctx, input.card);

	const name = input.name.trim();
	if (name === '') throw invalid('a field needs a name');
	if (name.length > FIELD_NAME_MAX) {
		throw invalid(`a field name may be at most ${FIELD_NAME_MAX} characters`);
	}

	const slug = fieldSlug(name);
	if (slug === '') throw invalid(`${JSON.stringify(input.name)} has no letters or digits in it`);

	if (input.value === null) {
		if (!deleteCardField(ctx.db, input.card, slug)) {
			throw notFound(`this card has no field called ${JSON.stringify(name)}`);
		}
		announceCard(ctx, input.card, row);
		ctx.bus.publish('fields.changed', { projectId: row.projectId });
		return { card: input.card, fields: fieldsOn(ctx, input.card), set: false };
	}

	const value = input.value.trim();
	if (value === '') throw invalid('a field needs a value, or null to remove it');
	if (value.length > FIELD_VALUE_MAX) {
		throw invalid(`a field value may be at most ${FIELD_VALUE_MAX} characters`);
	}

	const already = findCardField(ctx.db, input.card, slug);
	if (!already && fieldsOn(ctx, input.card).length >= FIELDS_PER_CARD) {
		throw invalid(`a card may carry at most ${FIELDS_PER_CARD} fields`);
	}

	// Quiet when nothing moved: setting a field to what it already says is not
	// news, and an event per no-op would redraw every open tab for nothing.
	if (already?.value === value && already.name === name) {
		return { card: input.card, fields: fieldsOn(ctx, input.card), set: true };
	}

	upsertCardField(ctx.db, {
		card: input.card,
		name,
		slug,
		value,
		author: authorText(input.actor),
		now: ctx.now()
	});

	announceCard(ctx, input.card, row);
	ctx.bus.publish('fields.changed', { projectId: row.projectId });
	return { card: input.card, fields: fieldsOn(ctx, input.card), set: true };
}

/** Every field on one card, oldest first. */
export function fieldsOn(ctx: DomainContext, card: CardRef): CardField[] {
	return listCardFields(ctx.db, { [card.kind]: [card.id] });
}

/** Which cards to read fields for, by kind. */
export type FieldScope = Partial<Record<CardKind, readonly string[]>>;

/** Every field on these cards, for a page of the feed. */
export function fieldsForCards(ctx: DomainContext, scope: FieldScope): CardField[] {
	return listCardFields(ctx.db, scope);
}
