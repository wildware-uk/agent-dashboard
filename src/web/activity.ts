/**
 * When a card last had something happen to it (design §7).
 *
 * The owner: "a comment on a post should move that post to the top of the feed."
 *
 * That is a change in what the timeline *is*. It was a record of when things were
 * posted; it becomes a record of what is going on — and the two only differ for a
 * card somebody has come back to, which is exactly the card worth seeing. A reply
 * to something from Tuesday is news on Thursday, and a feed that files it under
 * Tuesday has hidden the only new thing on it.
 *
 * So a card's place is decided by the later of two moments: when it was posted,
 * and when the newest live reply to it arrived. Ordering *and* the day heading
 * both follow from that, because they have to agree — a card sorted to the top
 * and grouped under Tuesday would appear above Wednesday's cards under a heading
 * saying otherwise, which is worse than either behaviour on its own.
 *
 * The card keeps showing its own age. "3d ago" under a Today heading is the
 * honest reading of a card that was posted three days ago and answered this
 * morning, and the thread beneath it says which reply did it.
 *
 * Moving work along counts too (migration 037). The owner: "make it so when a
 * cards work status is updated, it moves to the top of the feed." An agent
 * picking something up or marking it blocked is exactly as much news as a reply,
 * and leaving it where it was put it in the one place nobody would look.
 */

/** The little a card and a reply have in common: when they happened. */
export type Dated = { createdAt: number };

/**
 * The moment a card should be filed under.
 *
 * Deleting a comment puts the card back where it came from, and there is nothing
 * here that does it: a soft-deleted message never reaches the client at all, so
 * it is simply absent from `replies` and the card falls back to its own age. A
 * `deletedAt` check here would be a branch that could never run, describing a
 * field the client's messages do not carry.
 *
 * Replies arrive oldest first, but this takes the maximum rather than the last
 * one, because "the newest reply is last in the list" is an assumption about a
 * caller rather than about time.
 */
export function lastActivityAt(
	createdAt: number,
	replies: readonly Dated[] = [],
	/**
	 * When the card's work state last changed, if it ever has (migration 037).
	 *
	 * Optional because most cards are not work, and because a card whose state
	 * was set by the conversion from the old board (migration 035) carries none —
	 * that was a migration rather than somebody working on it, and counting it
	 * would have dragged forty-six finished tasks to the top of the feed.
	 */
	statusAt?: number | null
): number {
	let latest = createdAt;
	for (const reply of replies) {
		if (reply.createdAt > latest) latest = reply.createdAt;
	}
	if (statusAt !== null && statusAt !== undefined && statusAt > latest) latest = statusAt;
	return latest;
}

/**
 * The moment a card should say it was last *updated* (design §7).
 *
 * The owner: "when a card is updated for any reason, display how long ago it was
 * updated, instead of how long ago it was created."
 *
 * Wider than {@link lastActivityAt} on purpose. That one decides where a card
 * sits in the feed, and an edit deliberately does not move a card — correcting a
 * typo is not news to anybody. But "when did this last change" is exactly the
 * question the header answers, and an edit changed it, so it counts here.
 *
 * Returns `createdAt` itself when nothing has happened since, which is how the
 * caller knows to say "4m ago" rather than "updated 4m ago".
 */
export function lastUpdatedAt(
	createdAt: number,
	replies: readonly Dated[] = [],
	statusAt?: number | null,
	editedAt?: number | null
): number {
	const latest = lastActivityAt(createdAt, replies, statusAt);
	return editedAt !== null && editedAt !== undefined && editedAt > latest ? editedAt : latest;
}
