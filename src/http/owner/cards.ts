/**
 * The owner's writes that work on any card (migration 034).
 *
 * The owner: "let me pin my own messages, there are many discrepancies between
 * the card types, they should all share the same features."
 *
 * Pinning used to be a field on `PATCH /api/updates/[id]` and reacting a route
 * under `/api/messages/[id]`, because updates and messages were the cards those
 * features were built for. Neither is about a kind of card: they are about a
 * card. So there is one pair of routes, addressed by kind and id, and `$domain`
 * dispatches from there (`$domain/cards.ts`).
 *
 * The kind is validated here rather than trusted, because it reaches the
 * database as a table name: `isCardKind` is what stands between a path segment
 * and a query. Everything else — does the card exist, is it deleted, is that an
 * emoji — is the domain's, as always.
 */
import {
	isCardKind,
	isCardStatus,
	pinCard,
	react,
	setField,
	setStatus,
	tagCard,
	type CardRef
} from '$domain';
import { invalid } from '$domain/errors';
import { ownerAction, readOwnerJson, type OwnerHandler, type OwnerHandlerOptions } from './actions';

/** The card a path names, or a refusal — never a table name off the wire. */
function cardFrom(params: Partial<Record<string, string>>): CardRef {
	const kind = params.kind ?? '';
	if (!isCardKind(kind)) throw invalid(`no such kind of card: ${kind}`);

	const id = params.id ?? '';
	if (id === '') throw invalid('which card?');
	return { kind, id };
}

/**
 * `POST /api/cards/[kind]/[id]/pin` — pin any card, or unpin it.
 *
 * `{ pinned: true | false }`, said explicitly rather than toggled: the owner may
 * have two tabs open, and a toggle sent twice from a double click would leave
 * the pin in whichever state the race decided.
 */
export function pinCardHandler(options: OwnerHandlerOptions = {}): OwnerHandler {
	return ownerAction(options, async (event, ctx) => {
		const body = (await readOwnerJson(event.request).catch(() => ({}))) as { pinned?: unknown };
		if (typeof body.pinned !== 'boolean') throw invalid('pinned must be true or false');

		const result = pinCard(ctx, { card: cardFrom(event.params), pinned: body.pinned });
		return { status: 200, body: { card: result.card, pinned: result.pinned } };
	});
}

/**
 * `POST /api/cards/[kind]/[id]/status` — mark a card as work, or move it along
 * (migration 035).
 *
 * `{ status: "todo" | "in_progress" | "blocked" | "done" | "cancelled" | null }`.
 * `null` takes the mark off, which is how a card marked by mistake goes back to
 * being an ordinary card. The board this replaced was a page of its own; this is
 * one field on the card the work is.
 */
export function setCardStatusHandler(options: OwnerHandlerOptions = {}): OwnerHandler {
	return ownerAction(options, async (event, ctx) => {
		const body = (await readOwnerJson(event.request).catch(() => ({}))) as { status?: unknown };
		if (body.status !== null && !isCardStatus(body.status)) {
			throw invalid('status must be one of the five work states, or null');
		}

		const result = setStatus(ctx, { card: cardFrom(event.params), status: body.status });
		return { status: 200, body: { card: result.card, status: result.status } };
	});
}

/**
 * `POST /api/cards/[kind]/[id]/reactions` — react to any card.
 *
 * Toggling by default, because that is what a click on a reaction means: the
 * same emoji twice takes it back. `{ on: true | false }` says which way
 * explicitly, for a control that knows what it is doing.
 */
export function reactToCardHandler(options: OwnerHandlerOptions = {}): OwnerHandler {
	return ownerAction(options, async (event, ctx) => {
		const body = (await readOwnerJson(event.request).catch(() => ({}))) as {
			emoji?: unknown;
			on?: unknown;
		};
		if (typeof body.emoji !== 'string') throw invalid('emoji must be a string');

		const result = react(ctx, {
			card: cardFrom(event.params),
			actor: { kind: 'human' },
			emoji: body.emoji,
			...(typeof body.on === 'boolean' ? { on: body.on } : {})
		});

		return { status: 200, body: { reactions: result.reactions, on: result.on } };
	});
}

/**
 * `POST /api/cards/[kind]/[id]/tags` — put one of the project's words on a card,
 * or take it off (migration 039).
 *
 * `{ tag, on? }`, where `tag` is a tag's id — the picker has the list, so it
 * sends an id rather than a word — and `on` is optional because a click on a
 * chip means "toggle". The owner may also define a word on the way, which is
 * what makes "one click" true on a card whose project has not got round to
 * deciding its vocabulary: `{ tag: "bug", create: true }`.
 */
export function tagCardHandler(options: OwnerHandlerOptions = {}): OwnerHandler {
	return ownerAction(options, async (event, ctx) => {
		const body = (await readOwnerJson(event.request).catch(() => ({}))) as {
			tag?: unknown;
			on?: unknown;
			create?: unknown;
		};
		if (typeof body.tag !== 'string' || body.tag.trim() === '') {
			throw invalid('tag must be a tag id, or the word itself');
		}

		const result = tagCard(ctx, {
			card: cardFrom(event.params),
			tag: body.tag,
			actor: { kind: 'human' },
			...(typeof body.on === 'boolean' ? { on: body.on } : {}),
			...(body.create === true ? { create: true } : {})
		});

		return { status: 200, body: { card: result.card, tag: result.tag, on: result.on } };
	});
}

/**
 * `POST /api/cards/[kind]/[id]/fields` — set a note on a card, or take it off
 * (migration 040).
 *
 * `{ name, value }`, with `value: null` to remove. The owner may correct what
 * an agent wrote and the other way round: a branch name is a fact about the
 * job, not a statement somebody made, so nobody owns it.
 */
export function setCardFieldHandler(options: OwnerHandlerOptions = {}): OwnerHandler {
	return ownerAction(options, async (event, ctx) => {
		const body = (await readOwnerJson(event.request).catch(() => ({}))) as {
			name?: unknown;
			value?: unknown;
		};
		if (typeof body.name !== 'string') throw invalid('name must be a string');
		if (body.value !== null && typeof body.value !== 'string') {
			throw invalid('value must be a string, or null to remove the field');
		}

		const result = setField(ctx, {
			card: cardFrom(event.params),
			name: body.name,
			value: body.value,
			actor: { kind: 'human' }
		});

		return { status: 200, body: { card: result.card, fields: result.fields, set: result.set } };
	});
}
