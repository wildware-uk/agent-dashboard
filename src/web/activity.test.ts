import { describe, expect, it } from 'vitest';
import { lastActivityAt, lastUpdatedAt } from './activity';

/**
 * When a card last had something happen to it (design §7).
 *
 * The owner: "a comment on a post should move that post to the top of the feed."
 * That changes what the timeline is — a record of when things were posted becomes
 * a record of what is going on — and the two only differ for a card somebody has
 * come back to, which is exactly the card worth seeing.
 */
const POSTED = Date.UTC(2026, 8, 5, 9, 0);
const LATER = Date.UTC(2026, 8, 8, 11, 0);

describe('a card`s place in the feed', () => {
	it('is when it was posted, while nobody has said anything', () => {
		expect(lastActivityAt(POSTED)).toBe(POSTED);
		expect(lastActivityAt(POSTED, [])).toBe(POSTED);
	});

	it('moves to the newest reply', () => {
		expect(lastActivityAt(POSTED, [{ createdAt: LATER }])).toBe(LATER);
	});

	it('takes the newest, not the last in the list', () => {
		// Replies arrive oldest first, but "the newest is last" is an assumption
		// about a caller rather than about time.
		expect(lastActivityAt(POSTED, [{ createdAt: LATER }, { createdAt: POSTED + 1_000 }])).toBe(
			LATER
		);
	});

	it('goes back where it came from once the comment is gone', () => {
		// Deleting the only comment on an old card un-bumps it, and nothing here
		// does that: a soft-deleted message never reaches the client, so the card
		// simply has no replies again.
		expect(lastActivityAt(POSTED, [])).toBe(POSTED);
	});

	it('never moves a card backwards', () => {
		// A reply cannot predate its post, but a clock skew or a bad fixture should
		// not be able to file a card before it existed.
		expect(lastActivityAt(LATER, [{ createdAt: POSTED }])).toBe(LATER);
	});
});

/**
 * Work that moves comes back (migration 037).
 *
 * The owner: "make it so when a cards work status is updated, it moves to the
 * top of the feed." Marking something `in_progress` is exactly as much news as
 * a reply, and leaving the card where it was put it where nobody would look.
 */
describe('a card whose work state changed', () => {
	it('is filed by when it moved, not by when it was posted', () => {
		expect(lastActivityAt(POSTED, [], LATER)).toBe(LATER);
	});

	it('takes whichever happened last, a reply or a move', () => {
		expect(lastActivityAt(POSTED, [{ createdAt: LATER }], POSTED + 1_000)).toBe(LATER);
		expect(lastActivityAt(POSTED, [{ createdAt: POSTED + 1_000 }], LATER)).toBe(LATER);
	});

	it('ignores a state nobody has touched since the column existed', () => {
		// The cards converted from the old board carry a state and no moment: that
		// was a migration rather than somebody working, and counting it would drag
		// every finished task to the top on first paint.
		expect(lastActivityAt(POSTED, [], null)).toBe(POSTED);
		expect(lastActivityAt(POSTED, [], undefined)).toBe(POSTED);
	});

	it('never moves a card backwards', () => {
		expect(lastActivityAt(LATER, [], POSTED)).toBe(LATER);
	});
});

describe('lastUpdatedAt', () => {
	it('is the card itself when nothing has happened to it', () => {
		expect(lastUpdatedAt(POSTED)).toBe(POSTED);
	});

	it('takes the newest reply', () => {
		expect(lastUpdatedAt(POSTED, [{ createdAt: LATER }])).toBe(LATER);
	});

	it('takes a work state that moved', () => {
		expect(lastUpdatedAt(POSTED, [], LATER)).toBe(LATER);
	});

	it('takes an edit, which the ordering deliberately ignores', () => {
		expect(lastUpdatedAt(POSTED, [], null, LATER)).toBe(LATER);
		expect(lastActivityAt(POSTED, [])).toBe(POSTED);
	});

	it('ignores an edit older than the newest reply', () => {
		expect(lastUpdatedAt(POSTED, [{ createdAt: LATER }], null, POSTED + 1)).toBe(LATER);
	});
});
