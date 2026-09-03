/**
 * Reading an edge swipe (design §7: a phone is not a fallback).
 *
 * The owner asked for it in as many words: swiping in from the left edge should
 * open the project drawer, "instead of going back". That second half is the
 * hard part — a swipe from the very edge is also the browser's own back
 * gesture, and the only way to have it mean something else is to claim it
 * before the browser does, which means starting *at* the edge and saying so
 * early.
 *
 * The decision is here rather than in the component so it can be reasoned about
 * without a touchscreen: a gesture is four numbers and a verdict, and the
 * component is left with listeners.
 *
 * Three judgements, and each has a reason a phone made necessary:
 *
 * - **It has to start at the edge.** {@link EDGE_PX} from the left, or a drag
 *   that begins in the middle of a card would open the drawer while somebody is
 *   scrolling a code block sideways.
 * - **It has to be mostly horizontal.** A thumb travelling down the feed passes
 *   through a few pixels of horizontal drift; requiring the horizontal movement
 *   to dominate is what tells a swipe from a scroll.
 * - **It has to be long enough** to be deliberate ({@link DISTANCE_PX}), so a
 *   tap that wobbles is a tap.
 */

/** How close to the edge a swipe must start to count as an edge swipe. */
export const EDGE_PX = 28;

/** How far it must travel before it is a swipe rather than a wobble. */
export const DISTANCE_PX = 56;

/**
 * How much more horizontal than vertical the movement must be.
 *
 * 1.5 rather than 1: a diagonal is somebody scrolling with a lazy thumb, and
 * opening a drawer under them is worse than ignoring one deliberate swipe.
 */
export const HORIZONTAL_RATIO = 1.5;

/** Where the viewport is, and where a gesture began and ended. */
export type Gesture = {
	startX: number;
	startY: number;
	endX: number;
	endY: number;
	/** The viewport width, for the right-edge case a right-hand drawer would use. */
	width: number;
};

/** What a gesture means, or `null` for one that means nothing. */
export type SwipeVerdict = 'open-left' | 'close-left' | null;

/**
 * Read one gesture.
 *
 * @param open whether the drawer is already open — a swipe back towards the
 *   edge closes it, which is the gesture anybody who has opened one expects.
 */
export function readSwipe(gesture: Gesture, open: boolean): SwipeVerdict {
	const dx = gesture.endX - gesture.startX;
	const dy = gesture.endY - gesture.startY;

	if (Math.abs(dx) < DISTANCE_PX) return null;
	if (Math.abs(dx) < Math.abs(dy) * HORIZONTAL_RATIO) return null;

	if (open) return dx < 0 ? 'close-left' : null;
	return dx > 0 && gesture.startX <= EDGE_PX ? 'open-left' : null;
}

/**
 * How far a finger must have travelled before the gesture is claimed.
 *
 * Small, because the browser decides early; but not zero, and that is the fix
 * for a bug this feature caused. Claiming on the *first touch* refused the
 * default action of every tap it applied to — which on a phone meant the
 * project links in the open drawer stopped working: the owner could see them and
 * could not select them. A tap has no movement, so waiting for movement leaves
 * every tap alone.
 */
export const CLAIM_PX = 10;

/**
 * Whether this movement is one the page wants, rather than the browser's.
 *
 * Called as the finger moves, which is the last moment a back gesture can still
 * be refused and the first at which a swipe can be told from a tap. Being wrong
 * costs a scroll that does not navigate back; claiming too eagerly costs every
 * tap underneath, which is worse.
 */
export function claimsMove(
	gesture: { startX: number; dx: number; dy: number },
	open: boolean
): boolean {
	if (!open && gesture.startX > EDGE_PX) return false;
	if (Math.abs(gesture.dx) < CLAIM_PX) return false;
	return Math.abs(gesture.dx) > Math.abs(gesture.dy);
}
