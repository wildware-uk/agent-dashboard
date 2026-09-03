import { describe, expect, it } from 'vitest';
import { CLAIM_PX, DISTANCE_PX, EDGE_PX, claimsMove, readSwipe } from './swipe';

/**
 * Reading an edge swipe.
 *
 * The owner asked for a swipe in from the left to open the project drawer
 * "instead of going back". The cases that matter are the ones where a phone
 * lies to you: a scroll with drift in it, a tap that wobbles, a drag that
 * started in the middle of the screen.
 */

const gesture = (from: [number, number], to: [number, number]) => ({
	startX: from[0],
	startY: from[1],
	endX: to[0],
	endY: to[1],
	width: 390
});

describe('opening', () => {
	it('opens on a long pull in from the very edge', () => {
		expect(readSwipe(gesture([4, 400], [4 + DISTANCE_PX + 10, 405]), false)).toBe('open-left');
	});

	it('ignores the same pull started in the middle of the screen', () => {
		// Somebody dragging a wide code block sideways, which happens constantly.
		expect(readSwipe(gesture([180, 400], [300, 405]), false)).toBeNull();
	});

	it('ignores a scroll with a little sideways drift in it', () => {
		expect(readSwipe(gesture([6, 500], [6 + DISTANCE_PX + 10, 200]), false)).toBeNull();
	});

	it('ignores a tap that wobbles', () => {
		expect(readSwipe(gesture([6, 400], [6 + DISTANCE_PX - 20, 402]), false)).toBeNull();
	});

	it('ignores a pull the wrong way', () => {
		expect(readSwipe(gesture([EDGE_PX, 400], [EDGE_PX - 80, 402]), false)).toBeNull();
	});
});

describe('closing', () => {
	it('closes on a pull back towards the edge', () => {
		expect(readSwipe(gesture([300, 400], [300 - DISTANCE_PX - 10, 405]), true)).toBe('close-left');
	});

	it('does nothing on a pull further in while it is already open', () => {
		expect(readSwipe(gesture([100, 400], [100 + DISTANCE_PX + 10, 405]), true)).toBeNull();
	});
});

describe('claiming the gesture from the browser', () => {
	const move = (startX: number, dx: number, dy: number) => ({ startX, dx, dy });

	it('claims a sideways drag from the edge, which is where back lives', () => {
		expect(claimsMove(move(3, CLAIM_PX + 5, 2), false)).toBe(true);
	});

	/**
	 * The bug this feature caused, and the reason claiming waits for movement.
	 *
	 * Claiming on the first touch refused the default action of every tap it
	 * applied to, so on a phone the project links stopped working: visible, and
	 * unselectable. A tap has no movement in it.
	 */
	it('leaves a tap alone, even one right on the edge', () => {
		expect(claimsMove(move(3, 0, 0), false)).toBe(false);
		expect(claimsMove(move(3, 2, 1), false)).toBe(false);
	});

	it('leaves a tap in the open drawer alone, which is how a project is picked', () => {
		expect(claimsMove(move(200, 0, 0), true)).toBe(false);
		expect(claimsMove(move(200, 3, 2), true)).toBe(false);
	});

	it('leaves the rest of the screen alone while the drawer is shut', () => {
		expect(claimsMove(move(EDGE_PX + 1, 40, 2), false)).toBe(false);
	});

	it('claims a sideways drag anywhere while the drawer is open, to swipe it shut', () => {
		expect(claimsMove(move(300, -40, 3), true)).toBe(true);
	});

	it('leaves a vertical scroll alone', () => {
		expect(claimsMove(move(3, 12, 60), false)).toBe(false);
	});
});
