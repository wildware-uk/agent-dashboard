import { describe, expect, it } from 'vitest';
import { DISTANCE_PX, EDGE_PX, claimsGesture, readSwipe } from './swipe';

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
	it('claims a touch that starts at the edge, which is where back lives', () => {
		expect(claimsGesture(3, false)).toBe(true);
		expect(claimsGesture(EDGE_PX, false)).toBe(true);
	});

	it('leaves the rest of the screen alone', () => {
		expect(claimsGesture(EDGE_PX + 1, false)).toBe(false);
	});

	it('claims anywhere while the drawer is open, so it can be swiped shut', () => {
		expect(claimsGesture(300, true)).toBe(true);
	});
});
