/**
 * Reactions: the quick way to say something (migration 024).
 *
 * The owner asked for it and said what it is for: "looking at, done, agree,
 * disagree, emotions etc, its a nice simple way to allow quick communication."
 * They also noticed it overlaps the acknowledgement system, and they are right
 * — an eyes reaction says what `acknowledge({ state: 'thinking' })` says, in
 * one call, in a vocabulary nobody had to design. Acknowledgements stay for now
 * (a live "is thinking…" is a claim about *right now*, which a static emoji is
 * not), but an agent that reacts is no longer silent, and that was the point of
 * both.
 *
 * Three decisions worth stating.
 *
 * **A reaction is a switch, not an event.** One row per (message, reactor,
 * emoji), so reacting twice is the same state and taking one back is a delete.
 * That is what makes it safe to retry, and it means a card can count rows.
 *
 * **The emoji is text, not an id.** A closed table of allowed reactions would
 * be a list somebody has to maintain, and the feature's whole value is that it
 * is quicker than typing. What *is* enforced is that it looks like a reaction
 * rather than a message: short, no whitespace, and not plain ASCII words —
 * plus a handful of shortcodes translated for agents, because the owner wrote
 * `:eyes:` and `:tick:` and an agent will too.
 *
 * **Who is reacting comes from the caller's identity**, never from an argument:
 * the owner from the session cookie, an agent from its bearer token (design §5).
 *
 * What is left in this file is the vocabulary — what counts as an emoji. Putting
 * one on something lives in `./cards.ts` with the rest of the features every
 * card shares (migration 034): a reaction on a task is the same act as a
 * reaction on a message, and it should not be a second copy of this code.
 */
import { invalid } from './errors';

/**
 * The longest a reaction may be.
 *
 * Long enough for a family emoji with skin tones and joiners, which really do
 * run to a dozen code units, and short enough that nobody can smuggle a
 * sentence in as a reaction.
 */
export const EMOJI_MAX_LENGTH = 24;

/**
 * Shortcodes an agent is likely to write, translated.
 *
 * Not a general emoji dictionary — that is a dependency and a maintenance job.
 * These are the ones the owner named plus the obvious neighbours, so an agent
 * writing `:eyes:` gets the eyes rather than a refusal it has to learn from.
 */
export const SHORTCODES: Record<string, string> = {
	eyes: '👀',
	tick: '✅',
	check: '✅',
	white_check_mark: '✅',
	done: '✅',
	'+1': '👍',
	thumbsup: '👍',
	'-1': '👎',
	thumbsdown: '👎',
	tada: '🎉',
	rocket: '🚀',
	heart: '❤️',
	thinking: '🤔',
	thinking_face: '🤔',
	warning: '⚠️',
	x: '❌',
	fire: '🔥',
	pray: '🙏',
	smile: '😄'
};

/**
 * Whether a string holds anything outside ASCII: the cheap test for "this is a
 * character rather than a word".
 *
 * A code-point scan rather than a regular expression, because the expression
 * that says this most directly needs a control character in it and a linter is
 * right to refuse one.
 */
function hasNonAscii(value: string): boolean {
	for (const character of value) {
		if (character.codePointAt(0)! > 0x7f) return true;
	}
	return false;
}

/**
 * The emoji, checked and normalised.
 *
 * @throws {DomainError} `invalid_argument` for something that is not a
 *   reaction: empty, too long, whitespace in it, or ASCII text that is not a
 *   shortcode this module knows.
 */
export function assertEmoji(raw: unknown): string {
	if (typeof raw !== 'string') throw invalid('emoji must be a string');
	const trimmed = raw.trim();
	if (trimmed === '') throw invalid('emoji is required');

	// `:eyes:` or `eyes` — an agent will write either.
	const shortcode = trimmed.replace(/^:+|:+$/g, '').toLowerCase();
	const known = SHORTCODES[shortcode];
	if (known) return known;

	if (trimmed.length > EMOJI_MAX_LENGTH) {
		throw invalid(`an emoji is at most ${EMOJI_MAX_LENGTH} characters`);
	}
	if (/\s/.test(trimmed)) throw invalid('an emoji has no spaces in it');
	// Still ASCII-only means a word rather than a reaction, and the shortcodes
	// above are the only words this accepts.
	if (!hasNonAscii(trimmed)) {
		throw invalid(
			`${JSON.stringify(trimmed)} is not an emoji. Send the character itself, or one of: ` +
				Object.keys(SHORTCODES).slice(0, 8).join(', ')
		);
	}

	return trimmed;
}
