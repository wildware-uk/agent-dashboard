// The app's real stylesheet, so the animation assertion measures what a browser
// would actually run rather than a class name that might not exist.
import '../http/routes/app.css';
import { render } from 'vitest-browser-svelte';
import { describe, expect, it } from 'vitest';
import Ack from './Ack.svelte';
import { anAck } from './testing';

/**
 * What an agent has said about a message or a task, without words
 * (migration 013).
 *
 * The rule this file is really about is the last one: `thinking` is a claim
 * about *now*, so it is shown only while the agent that made it is online. An
 * animation running against a dead session is a lie the owner cannot check,
 * which is the same silence the feature exists to end.
 */
const names = { a1: 'scout', a2: 'megamerge' };

describe('done', () => {
	it('is a tick and a sentence, whether or not the agent is still running', async () => {
		const screen = render(Ack, {
			acks: [anAck({ state: 'done' })],
			agentNames: names,
			onlineIds: []
		});

		await expect.element(screen.getByText('scout marked this done')).toBeInTheDocument();
		expect(document.querySelector('[data-ack-done]')).not.toBeNull();
	});

	it('does not also claim the agent is thinking', async () => {
		render(Ack, { acks: [anAck({ state: 'done' })], agentNames: names, onlineIds: ['a1'] });

		expect(document.querySelector('[data-ack-thinking]')).toBeNull();
	});
});

describe('thinking', () => {
	it('says who is thinking, while that agent is online', async () => {
		const screen = render(Ack, {
			acks: [anAck({ state: 'thinking' })],
			agentNames: names,
			onlineIds: ['a1']
		});

		await expect.element(screen.getByText(/scout is thinking/)).toBeInTheDocument();
	});

	it('animates, rather than printing a static ellipsis', async () => {
		render(Ack, { acks: [anAck({ state: 'thinking' })], agentNames: names, onlineIds: ['a1'] });

		const dot = document.querySelector('.thinking-dots span')!;
		// Measured against the real stylesheet: a class that named no keyframes
		// would pass a class-name assertion and animate nothing.
		expect(getComputedStyle(dot).animationName).toBe('thinking-blink');
	});

	it('is hidden once the agent has gone, because it is a claim about now', async () => {
		render(Ack, { acks: [anAck({ state: 'thinking' })], agentNames: names, onlineIds: ['a2'] });

		expect(document.querySelector('[data-ack]')).toBeNull();
	});
});

describe('several agents on one thing', () => {
	it('shows each of them, and drops only the stale one', async () => {
		const screen = render(Ack, {
			acks: [
				anAck({ id: 'k1', agentId: 'a1', state: 'thinking' }),
				anAck({ id: 'k2', agentId: 'a2', state: 'done' })
			],
			agentNames: names,
			onlineIds: ['a1']
		});

		await expect.element(screen.getByText(/scout is thinking/)).toBeInTheDocument();
		await expect.element(screen.getByText('megamerge marked this done')).toBeInTheDocument();
	});
});

describe('nothing said', () => {
	it('renders no room at all, so an unacknowledged card is unchanged', async () => {
		render(Ack, { acks: [], agentNames: names, onlineIds: ['a1'] });

		expect(document.querySelector('[data-ack]')).toBeNull();
	});

	it('falls back to a readable label for an agent it cannot name', async () => {
		const screen = render(Ack, {
			acks: [anAck({ agentId: '01M0XN8Y9TJMEYSN5T6Y54T4A3', state: 'done' })],
			onlineIds: []
		});

		// Never the raw ULID: every one of them begins `01` until 2039, so the
		// fallback has to be something a reader can tell apart.
		await expect
			.element(screen.getByText(/marked this done/))
			.not.toHaveTextContent('01M0XN8Y9TJMEYSN5T6Y54T4A3');
	});
});
