// The app's real stylesheet, so the animation assertion measures what a browser
// would actually run rather than a class name that might not exist.
import '../http/routes/app.css';
import { render } from 'vitest-browser-svelte';
import { describe, expect, it } from 'vitest';
import Ack from './Ack.svelte';
import { THINKING_MAX_AGE_MS } from './acks';
import { aDelivery, anAck } from './testing';
import type { AckView } from './types';

/**
 * What an agent has said about a message or a task, without words
 * (migration 013).
 *
 * The rule this file is really about is the last one: `thinking` is a claim
 * about *now*, so it is shown only while the agent that made it is online. An
 * animation running against a dead session is a lie the owner cannot check,
 * which is the same silence the feature exists to end.
 */
const names = { a1: 'scout', a2: 'gardengame' };

/**
 * When the fixture's acknowledgements were made, and an instant a moment later.
 *
 * Passed explicitly rather than left to the wall clock: `thinking` now expires,
 * so "is this still current" is part of what these assert and a test that read
 * the real clock would be about how long the suite took to start.
 */
const AT = Date.UTC(2026, 7, 25, 11, 1);
const JUST_AFTER = AT + 1_000;

/** An acknowledgement made at {@link AT}, so age is this file's to decide. */
const at = (overrides: Partial<AckView> = {}) =>
	anAck({ createdAt: AT, updatedAt: AT, ...overrides });

describe('done', () => {
	it('is a tick and a sentence, whether or not the agent is still running', async () => {
		const screen = render(Ack, {
			acks: [at({ state: 'done' })],
			agentNames: names,
			onlineIds: []
		});

		await expect.element(screen.getByText('scout marked this done')).toBeInTheDocument();
		expect(document.querySelector('[data-ack-done]')).not.toBeNull();
	});

	it('does not also claim the agent is thinking', async () => {
		render(Ack, { acks: [at({ state: 'done' })], agentNames: names, onlineIds: ['a1'] });

		expect(document.querySelector('[data-ack-thinking]')).toBeNull();
	});
});

describe('thinking', () => {
	it('says who is thinking, while that agent is online', async () => {
		const screen = render(Ack, {
			acks: [at({ state: 'thinking' })],
			agentNames: names,
			onlineIds: ['a1'],
			now: JUST_AFTER
		});

		await expect.element(screen.getByText(/scout is thinking/)).toBeInTheDocument();
	});

	it('says work is still going on with a sweeping bar, and nothing else', async () => {
		render(Ack, {
			acks: [at({ state: 'thinking' })],
			agentNames: names,
			onlineIds: ['a1'],
			now: JUST_AFTER
		});

		const bar = document.querySelector('[data-testid="thinking-bar"]')!;
		// Measured against the real stylesheet: a class that named no keyframes
		// would pass a class-name assertion and animate nothing.
		expect(getComputedStyle(bar, '::after').animationName).toBe('thinking-sweep');
		// The blinking dots went with the owner's "remove the dots, in favour of
		// the loading bar": two things saying the same thing in one line.
		expect(document.querySelector('.thinking-dots')).toBeNull();
	});

	it('is hidden once the agent has gone, because it is a claim about now', async () => {
		render(Ack, { acks: [at({ state: 'thinking' })], agentNames: names, onlineIds: ['a2'] });

		expect(document.querySelector('[data-ack]')).toBeNull();
	});
});

describe('several agents on one thing', () => {
	it('shows each of them, and drops only the stale one', async () => {
		const screen = render(Ack, {
			acks: [
				at({ id: 'k1', agentId: 'a1', state: 'thinking' }),
				at({ id: 'k2', agentId: 'a2', state: 'done' })
			],
			agentNames: names,
			onlineIds: ['a1'],
			now: JUST_AFTER
		});

		await expect.element(screen.getByText(/scout is thinking/)).toBeInTheDocument();
		await expect.element(screen.getByText('gardengame marked this done')).toBeInTheDocument();
	});
});

describe('nothing said', () => {
	it('renders no room at all, so an unacknowledged card is unchanged', async () => {
		render(Ack, { acks: [], agentNames: names, onlineIds: ['a1'] });

		expect(document.querySelector('[data-ack]')).toBeNull();
	});

	it('falls back to a readable label for an agent it cannot name', async () => {
		const screen = render(Ack, {
			acks: [at({ agentId: '01M0XN8Y9TJMEYSN5T6Y54T4A3', state: 'done' })],
			onlineIds: []
		});

		// Never the raw ULID: every one of them begins `01` until 2039, so the
		// fallback has to be something a reader can tell apart.
		await expect
			.element(screen.getByText(/marked this done/))
			.not.toHaveTextContent('01M0XN8Y9TJMEYSN5T6Y54T4A3');
	});
});

/**
 * "Read" (the owner's ask): agents were reluctant to say `done` about a
 * message, so they said nothing. The smallest honest word gets its own badge.
 */
describe('has read this', () => {
	it('shows a read acknowledgement whether or not the agent is still online', async () => {
		const screen = render(Ack, {
			acks: [anAck({ id: 'a1', agentId: 'a1', state: 'read' })],
			agentNames: { a1: 'scout' },
			onlineIds: []
		});

		await expect.element(screen.getByText('scout has read this')).toBeVisible();
		expect(document.querySelector('[data-ack-read]')).not.toBeNull();
	});

	it('is not the tick, so "seen it" cannot be misread as "finished"', async () => {
		render(Ack, {
			acks: [anAck({ id: 'a1', agentId: 'a1', state: 'read' })],
			agentNames: { a1: 'scout' }
		});

		expect(document.querySelector('[data-ack-done]')).toBeNull();
	});
});

/**
 * "Delivered" (migration 018): the state before anybody says anything.
 *
 * The owner asked for it after watching a message sit with nothing under it,
 * unable to tell an agent that had it and was busy from one never told.
 */
describe('delivered to', () => {
	it('names the agent the server handed it to', async () => {
		const screen = render(Ack, {
			deliveries: [aDelivery({ agentId: 'a1' })],
			agentNames: { a1: 'scout' }
		});

		await expect.element(screen.getByText('delivered to scout')).toBeVisible();
	});

	it('gives way to anything the agent actually said', async () => {
		render(Ack, {
			acks: [anAck({ id: 'ack1', agentId: 'a1', state: 'read' })],
			deliveries: [aDelivery({ agentId: 'a1' })],
			agentNames: { a1: 'scout' }
		});

		// One line, not two: "read" already means it arrived.
		expect(document.querySelector('[data-ack-delivered]')).toBeNull();
		expect(document.querySelector('[data-ack-read]')).not.toBeNull();
	});

	it('still shows for an agent that has said nothing, beside one that has', async () => {
		const screen = render(Ack, {
			acks: [anAck({ id: 'ack1', agentId: 'a1', state: 'done' })],
			deliveries: [aDelivery({ id: 'del2', agentId: 'a2' })],
			agentNames: { a1: 'scout', a2: 'runner' }
		});

		await expect.element(screen.getByText('scout marked this done')).toBeVisible();
		await expect.element(screen.getByText('delivered to runner')).toBeVisible();
	});
});

/**
 * A claim that has stopped being about now (the owner's report).
 *
 * Their words: "'Agent is thinking' seems to hang around on posts too long."
 * Being online was not enough to stop it, because presence is per *agent* and
 * the claim is really per *session* — several sessions share one token here, so
 * while any of them beats, every abandoned "thinking" any of them ever left is
 * still animating on posts from hours ago.
 */
describe('a thinking that has gone stale', () => {
	const OLD = AT + THINKING_MAX_AGE_MS + 1;

	it('stops animating once the claim is older than the idle window', async () => {
		render(Ack, {
			acks: [at({ state: 'thinking' })],
			agentNames: names,
			// Online the whole time: this is the case being fixed, where presence
			// said yes and the animation still should not have been there.
			onlineIds: ['a1'],
			now: OLD
		});

		expect(document.querySelector('[data-ack]')).toBeNull();
	});

	it('keeps animating right up to the window', async () => {
		const screen = render(Ack, {
			acks: [at({ state: 'thinking' })],
			agentNames: names,
			onlineIds: ['a1'],
			now: AT + THINKING_MAX_AGE_MS - 1_000
		});

		await expect.element(screen.getByText(/scout is thinking/)).toBeInTheDocument();
	});

	it('comes back when the agent says it again', async () => {
		// `acknowledge` is explicit that sending twice is safe, and each send moves
		// `updatedAt` — so an agent that is genuinely still working keeps its
		// animation for as long as it keeps claiming it.
		const screen = render(Ack, {
			acks: [at({ state: 'thinking', updatedAt: OLD })],
			agentNames: names,
			onlineIds: ['a1'],
			now: OLD + 1_000
		});

		await expect.element(screen.getByText(/scout is thinking/)).toBeInTheDocument();
	});

	it('never expires a done or a read, which are facts about the past', async () => {
		const screen = render(Ack, {
			acks: [at({ state: 'done' })],
			agentNames: names,
			onlineIds: [],
			now: AT + THINKING_MAX_AGE_MS * 100
		});

		await expect.element(screen.getByText('scout marked this done')).toBeInTheDocument();
	});
});

/**
 * A message that reached nobody (design §7).
 *
 * The owner: "when a message isn't delivered yet, hold a red icon saying it
 * wasn't delivered to an agent."
 */
describe('nothing received it', () => {
	const POSTED = Date.UTC(2026, 8, 20, 12, 0);

	it('says so in red once delivery has had time to happen', async () => {
		const screen = render(Ack, {
			acks: [],
			deliveries: [],
			expects: { createdAt: POSTED },
			now: POSTED + 60_000
		});

		await expect.element(screen.getByText('Not delivered to any agent')).toBeInTheDocument();
		const icon = screen.container.querySelector('[data-ack-undelivered]')!;
		expect(getComputedStyle(icon).color).toBe('oklch(0.645 0.246 16.439)');
	});

	it('stays quiet while delivery could still be in flight', async () => {
		const screen = render(Ack, {
			acks: [],
			deliveries: [],
			expects: { createdAt: POSTED },
			now: POSTED + 1_000
		});

		expect(screen.container.querySelector('[data-ack-undelivered]')).toBeNull();
	});

	it('stays quiet once an agent has it', async () => {
		const screen = render(Ack, {
			acks: [],
			deliveries: [aDelivery({ agentId: 'a1' })],
			expects: { createdAt: POSTED },
			now: POSTED + 60_000
		});

		expect(screen.container.querySelector('[data-ack-undelivered]')).toBeNull();
	});

	it('claims nothing about a card that was never meant to reach an agent', async () => {
		// An agent's own update is not "undelivered": there is nobody it was
		// addressed to.
		const screen = render(Ack, { acks: [], deliveries: [], now: POSTED + 60_000 });

		expect(screen.container.querySelector('[data-ack-undelivered]')).toBeNull();
	});
});
