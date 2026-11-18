import { describe, expect, it } from 'vitest';
import {
	THINKING_MAX_AGE_MS,
	thinkingIsCurrent,
	isUndelivered,
	UNDELIVERED_AFTER_MS
} from './acks';

/**
 * When an agent's "thinking" stops being true (migration 013).
 *
 * The owner's report: "'Agent is thinking' seems to hang around on posts too
 * long." Being online was not enough to stop it, because presence is per *agent*
 * and the claim is really per *session* — several sessions share one bearer
 * token in a normal setup, so while any of them is beating, every abandoned
 * "thinking" any session ever left keeps animating.
 */
const AT = Date.UTC(2026, 7, 25, 11, 1);

describe('whether a thinking is still about now', () => {
	it('holds while the claim is fresh', () => {
		expect(thinkingIsCurrent({ state: 'thinking', updatedAt: AT }, AT)).toBe(true);
		expect(
			thinkingIsCurrent({ state: 'thinking', updatedAt: AT }, AT + THINKING_MAX_AGE_MS - 1)
		).toBe(true);
	});

	it('lapses at the window, which is the one the server closes a session after', () => {
		expect(thinkingIsCurrent({ state: 'thinking', updatedAt: AT }, AT + THINKING_MAX_AGE_MS)).toBe(
			false
		);
	});

	it('is renewed by the agent saying it again', () => {
		// A ceiling on silence, not on work: `acknowledge` says plainly that
		// sending twice is safe, and each send moves `updatedAt`.
		const later = AT + THINKING_MAX_AGE_MS * 3;
		expect(thinkingIsCurrent({ state: 'thinking', updatedAt: later }, later + 1_000)).toBe(true);
	});

	it('never lapses a done or a read, which are facts about the past', () => {
		const ages = AT + THINKING_MAX_AGE_MS * 100;
		expect(thinkingIsCurrent({ state: 'done', updatedAt: AT }, ages)).toBe(true);
		expect(thinkingIsCurrent({ state: 'read', updatedAt: AT }, ages)).toBe(true);
	});

	it('agrees with the server`s idle window rather than keeping a second number', () => {
		// `SESSION_IDLE_MS` in `$domain/sessions.ts`. Stated as a literal here on
		// purpose: `$web` talks to the HTTP API and to nothing below it (design §2),
		// so the two are kept equal by this assertion rather than by an import.
		expect(THINKING_MAX_AGE_MS).toBe(10 * 60_000);
	});
});

/**
 * A message that reached nobody (design §7).
 *
 * The owner: "when a message isn't delivered yet, hold a red icon saying it
 * wasn't delivered to an agent." The silence this catches is the worst one on
 * the dashboard — the owner types, and nothing at all is listening.
 */
describe('saying that nothing received it', () => {
	const POSTED = Date.UTC(2026, 8, 20, 12, 0);
	const later = (ms: number) => POSTED + ms;

	it('says nothing while delivery could still be in flight', () => {
		// A red mark that flashed on every message for a second would teach the
		// reader to ignore it.
		expect(isUndelivered({ createdAt: POSTED }, [], [], later(1_000))).toBe(false);
	});

	it('says so once nothing has arrived for long enough', () => {
		expect(isUndelivered({ createdAt: POSTED }, [], [], later(UNDELIVERED_AFTER_MS))).toBe(true);
	});

	it('says nothing once it has been delivered', () => {
		expect(isUndelivered({ createdAt: POSTED }, [], [{ id: 'd1' }], later(60_000))).toBe(false);
	});

	it('says nothing once an agent has acknowledged it, delivery row or not', () => {
		// An agent that answered plainly has the message, whatever the delivery
		// table recorded.
		expect(isUndelivered({ createdAt: POSTED }, [{ id: 'a1' }], [], later(60_000))).toBe(false);
	});
});
