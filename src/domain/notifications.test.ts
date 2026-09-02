import { beforeEach, describe, expect, it } from 'vitest';
import { harness, type Harness } from './testing';
import { createProject } from './projects';
import { postUpdate } from './updates';
import { postMessage } from './messages';
import { createRequest } from './requests';
import {
	countUnseen,
	listNotifications,
	markSeen,
	startNotificationRecorder
} from './notifications';

/**
 * Notifications the owner can find in the app (migration 021).
 *
 * The ask was two things at once: everything they would be told about has to
 * survive as something they can read later, and reading it has to take them to
 * the thing itself rather than to the top of a project.
 */

let h: Harness;
let agentId: string;
let slug: string;
let stop: () => void;

beforeEach(() => {
	h = harness();
	agentId = h.agent('scout');
	slug = createProject(h, { name: 'Agent Dashboard' }).project.slug;
	stop = startNotificationRecorder({ context: () => h, bus: h.bus });
	return () => stop();
});

describe('what gets recorded', () => {
	it('records an update, pointing at the card', () => {
		const update = postUpdate(h, { project: slug, agentId, title: 'Shipped', body: 'all green' });

		const [first] = listNotifications(h);

		expect(first).toMatchObject({
			kind: 'update',
			updateId: update.id,
			title: 'Shipped',
			body: 'all green'
		});
		expect(first.path).toBe(`/projects/${slug}?focus=${update.id}`);
	});

	it('records an agent’s reply, pointing at the reply itself', () => {
		const update = postUpdate(h, { project: slug, agentId, body: 'shipped' });
		postMessage(h, { author: { kind: 'human' }, updateId: update.id, body: 'does it work?' });
		const said = postMessage(h, {
			author: { kind: 'agent', agentId },
			updateId: update.id,
			body: 'it does'
		});

		const notification = listNotifications(h).find((row) => row.messageId === said.id);

		// "replied to you", not "commented": the owner spoke in this thread, so
		// the answer is aimed at them.
		expect(notification).toMatchObject({ kind: 'reply', title: 'scout replied to you' });
		expect(notification?.path).toBe(`/projects/${slug}?focus=${said.id}`);
	});

	it('records a request, which is the one they most need to find again', () => {
		const { request } = createRequest(h, {
			agentId,
			kind: 'confirm',
			question: 'Ship it?',
			project: slug
		});

		const [first] = listNotifications(h);

		expect(first).toMatchObject({ kind: 'request', requestId: request.id, body: 'Ship it?' });
	});

	it('says nothing about the owner’s own words', () => {
		postMessage(h, { author: { kind: 'human' }, project: slug, body: 'a note to myself' });

		expect(listNotifications(h)).toEqual([]);
	});

	it('records one notification per thing, however often the event arrives', () => {
		const update = postUpdate(h, { project: slug, agentId, body: 'shipped' });
		// The same event again, which a replay produces and two subscribers can
		// race to handle. The count is what the owner reads as "how much is
		// waiting", so it must not double.
		h.bus.publish('update.created', {
			updateId: update.id,
			projectId: update.projectId,
			agentId
		});

		expect(listNotifications(h)).toHaveLength(1);
		expect(countUnseen(h)).toBe(1);
	});
});

describe('the bell', () => {
	it('counts what has not been looked at, and clears when it is', () => {
		postUpdate(h, { project: slug, agentId, body: 'one' });
		postUpdate(h, { project: slug, agentId, body: 'two' });
		expect(countUnseen(h)).toBe(2);

		const events: unknown[] = [];
		h.bus.subscribe((event) => events.push(event));
		expect(markSeen(h)).toBe(2);

		expect(countUnseen(h)).toBe(0);
		// Announced, because the bell is on every open tab: cleared on the desk
		// has to mean cleared on the phone.
		expect(events).toEqual([
			expect.objectContaining({ type: 'notifications.seen', payload: { count: 2 } })
		]);
	});

	it('clears one at a time, for the one that was clicked', () => {
		postUpdate(h, { project: slug, agentId, body: 'one' });
		postUpdate(h, { project: slug, agentId, body: 'two' });
		const [newest] = listNotifications(h);

		markSeen(h, [newest.id]);

		expect(countUnseen(h)).toBe(1);
		expect(listNotifications(h, { unseenOnly: true }).map((row) => row.id)).not.toContain(
			newest.id
		);
	});

	it('says nothing when there was nothing to clear', () => {
		const events: unknown[] = [];
		h.bus.subscribe((event) => events.push(event));

		expect(markSeen(h)).toBe(0);
		expect(events).toEqual([]);
	});
});
