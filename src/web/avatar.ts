/**
 * The name-hashed avatar on every update card (design §7).
 *
 * A dashboard with several agents posting into one timeline is scanned by
 * colour long before it is read, so the badge has to be stable: the same agent
 * must get the same colour on every card, in every session, without a stored
 * palette or a colour column in the database. A hash of the name gives that for
 * free, and gives it identically on the server render and in the browser.
 *
 * Hue only. Saturation and lightness stay fixed so that no agent can draw a
 * badge that is illegible in one of the two themes.
 */

/** What a badge needs to render itself. */
export type Avatar = {
	/** One or two characters. Never empty. */
	initials: string;
	/** Degrees on the colour wheel, `0 <= hue < 360`. */
	hue: number;
};

/**
 * FNV-1a, 32-bit.
 *
 * Not a cryptographic choice — nothing here is a secret. It is small, it is
 * deterministic across the server and the browser, and it spreads short similar
 * strings (`agent-1`, `agent-2`) into different buckets, which a naive
 * character sum does not.
 */
function hash(text: string): number {
	let value = 0x811c9dc5;
	for (let index = 0; index < text.length; index += 1) {
		value ^= text.charCodeAt(index);
		value = Math.imul(value, 0x01000193);
	}
	return value >>> 0;
}

/** Word starts if there are any, otherwise the first two letters. */
function initialsFor(name: string): string {
	const words = name.split(/[^\p{L}\p{N}]+/u).filter((word) => word !== '');
	if (words.length === 0) return '?';
	if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
	return `${words[0][0]}${words[1][0]}`.toUpperCase();
}

/**
 * Derive a badge from whatever the card knows the poster as.
 *
 * @param name an agent's name, or its id while nothing has resolved the name —
 *   either way the badge is stable for that string.
 */
export function avatarFor(name: string): Avatar {
	const key = name.trim().toLowerCase();
	return { initials: initialsFor(key), hue: hash(key) % 360 };
}

/**
 * How much of an unresolved id is kept.
 *
 * The **tail**, not the head: a ULID's leading characters are its timestamp, so
 * two agents minted the same week share them, while the trailing characters are
 * the random half. Six of those are enough to tell two rows apart by eye.
 */
const ID_TAIL = 6;

/**
 * The longest id shown whole.
 *
 * Nothing this app mints is shorter than a 26-character ULID, so an id under
 * this length came from a human, a fixture or a migration — and those are
 * usually meaningful (`claude-code`), which shortening would throw away.
 */
const ID_READABLE_MAX = 12;

/**
 * What to call the agent that posted an update.
 *
 * The name when the timeline has resolved one, and otherwise something a person
 * can actually read. The fallback matters more than it looks: an unresolved
 * poster used to render its raw id, which is 26 characters of noise on the card
 * *and* — because every ULID begins `01` until September 2039 — made every
 * avatar in the timeline show the same two letters (#20).
 *
 * @param agentId the poster's id, which is always known.
 * @param name the display name, if anything has resolved one.
 */
export function agentLabel(agentId: string, name?: string | null): string {
	const named = name?.trim() ?? '';
	if (named !== '') return named;

	const id = agentId.trim();
	// A card with no poster at all is not a case the API can produce, but it is
	// one a component must survive: a badge and a header still have to say
	// something.
	if (id === '') return 'unknown agent';
	if (id.length <= ID_READABLE_MAX) return id;

	return `agent-${id.slice(-ID_TAIL).toLowerCase()}`;
}
