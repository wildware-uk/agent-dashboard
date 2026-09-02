import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findPushSubscription, listPushSubscriptions, markPushFailed } from '$db';
import { postMessage } from './messages';
import { createProject } from './projects';
import { postUpdate } from './updates';
import { createRequest } from './requests';
import { harness, type Harness } from './testing';
import {
	DEFAULT_PUSH_TYPES,
	MAX_PUSH_ACTIONS,
	MAX_PUSH_FAILURES,
	repliesToOwner,
	replyMessage,
	requestMessage,
	sendPush,
	startRequestPusher,
	subscribeToPush,
	assertPushPrefs,
	notifies,
	setDevicePrefs,
	unsubscribeFromPush
} from './push';

/**
 * Web Push (design §7).
 *
 * Nothing here talks to a push service: `sendPush` takes the sender as a seam,
 * so what is asserted is the decision this module actually owns — which
 * subscriptions survive a failure, and what the owner is told about a blocked
 * agent. Whether the bytes are encrypted correctly is `web-push`'s job.
 */
const KEYS = { publicKey: 'public', privateKey: 'private', subject: 'mailto:owner@example.com' };
const settings = () => KEYS;
const off = () => null;

let h: Harness;
let agentId: string;

beforeEach(() => {
	h = harness();
	agentId = h.agent('claude');
});

const subscribe = (endpoint = 'https://push.example/one') =>
	subscribeToPush(h, { endpoint, keys: { p256dh: 'p', auth: 'a' }, label: 'a phone' });

describe('storing a subscription', () => {
	it('takes what the browser hands over', () => {
		expect(subscribe()).toMatchObject({
			endpoint: 'https://push.example/one',
			p256dh: 'p',
			auth: 'a',
			label: 'a phone'
		});
	});

	it('refuses an endpoint that is not https, because it will be POSTed to', () => {
		expect(() =>
			subscribeToPush(h, { endpoint: 'http://push.example/x', keys: { p256dh: 'p', auth: 'a' } })
		).toThrow(/https/);
	});

	it('refuses one that is not a URL at all', () => {
		expect(() =>
			subscribeToPush(h, { endpoint: 'not-a-url', keys: { p256dh: 'p', auth: 'a' } })
		).toThrow(/absolute URL/);
	});

	it('refuses a subscription with no keys, which could never be encrypted for', () => {
		expect(() =>
			subscribeToPush(h, { endpoint: 'https://push.example/x', keys: { p256dh: '', auth: 'a' } })
		).toThrow(/keys/);
	});

	it('forgets one, twice, without complaining', () => {
		subscribe();

		expect(unsubscribeFromPush(h, 'https://push.example/one')).toBe(true);
		expect(unsubscribeFromPush(h, 'https://push.example/one')).toBe(false);
	});
});

describe('sending', () => {
	const message = { title: 'claude is waiting on you', body: 'Push to main?', url: '/', tag: 't' };

	it('does nothing at all when the deployment has no keypair', async () => {
		subscribe();
		const send = vi.fn();

		expect(await sendPush(h, message, { settings: off, send })).toEqual({
			sent: 0,
			removed: 0,
			failed: 0
		});
		expect(send).not.toHaveBeenCalled();
	});

	it('sends to every subscription, signed with the deployment keypair', async () => {
		subscribe('https://push.example/one');
		subscribe('https://push.example/two');
		const send = vi.fn().mockResolvedValue(undefined);

		expect(await sendPush(h, message, { settings, send })).toMatchObject({ sent: 2 });
		expect(send.mock.calls.map((call) => call[0].endpoint)).toEqual([
			'https://push.example/one',
			'https://push.example/two'
		]);
		expect(send.mock.calls[0][1]).toBe(JSON.stringify(message));
		expect(send.mock.calls[0][2].vapidDetails).toMatchObject(KEYS);
	});

	it('stamps a delivery, so the owner can see which browsers are live', async () => {
		subscribe();
		await sendPush(h, message, { settings, send: () => Promise.resolve() });

		expect(findPushSubscription(h.db, 'https://push.example/one')?.lastSentAt).not.toBeNull();
	});

	it('deletes a subscription the push service says is gone', async () => {
		subscribe();
		const gone = Object.assign(new Error('gone'), { statusCode: 410 });

		expect(
			await sendPush(h, message, { settings, send: () => Promise.reject(gone) })
		).toMatchObject({ removed: 1, sent: 0 });
		expect(listPushSubscriptions(h.db)).toEqual([]);
	});

	it('keeps one that failed for some other reason, and counts it', async () => {
		subscribe();
		const broken = Object.assign(new Error('bad gateway'), { statusCode: 502 });

		expect(
			await sendPush(h, message, { settings, send: () => Promise.reject(broken) })
		).toMatchObject({ failed: 1, removed: 0 });
		expect(findPushSubscription(h.db, 'https://push.example/one')?.failures).toBe(1);
	});

	it('gives up on one that has failed too many times in a row', async () => {
		subscribe();
		for (let attempt = 1; attempt < MAX_PUSH_FAILURES; attempt += 1) {
			markPushFailed(h.db, 'https://push.example/one');
		}
		const broken = Object.assign(new Error('bad gateway'), { statusCode: 502 });

		expect(
			await sendPush(h, message, { settings, send: () => Promise.reject(broken) })
		).toMatchObject({ removed: 1 });
		expect(listPushSubscriptions(h.db)).toEqual([]);
	});

	it('one failing subscription does not stop the others', async () => {
		subscribe('https://push.example/one');
		subscribe('https://push.example/two');
		const send = vi.fn(async (subscription: { endpoint: string }) => {
			if (subscription.endpoint.endsWith('one')) throw new Error('nope');
		});

		expect(await sendPush(h, message, { settings, send })).toMatchObject({ sent: 1, failed: 1 });
	});
});

describe('what the owner is told', () => {
	const ask = (over: Record<string, unknown> = {}) =>
		createRequest(h, {
			agentId,
			kind: 'confirm',
			question: 'Push the migration to main?',
			...over
		}).request;

	it('names the agent and asks its question, and nothing about the answer', () => {
		const request = ask();

		expect(requestMessage(h, request.id, 'https://agents.example.com')).toMatchObject({
			title: 'claude is waiting on you',
			body: 'Push the migration to main?',
			// No project to open, so the dashboard root — with a trailing slash,
			// because a URL that ends at the origin is one a service worker has to
			// normalise for itself.
			url: 'https://agents.example.com/',
			tag: `request-${request.id}`
		});
	});

	it('links to the project the agent stopped in, when it named one', () => {
		const { project } = createProject(h, { name: 'Mega Merge' });
		const request = ask({ project: project.slug });

		// With `focus`, so tapping it lands on the prompt itself rather than at the
		// top of a project with fifty cards under it (migration 021).
		expect(requestMessage(h, request.id, 'https://agents.example.com')?.url).toBe(
			`https://agents.example.com/projects/${project.slug}?focus=${request.id}`
		);
	});

	it('says nothing about a request that is no longer pending', () => {
		const request = ask();
		h.db.prepare(`UPDATE approvals SET state = 'approved' WHERE id = ?`).run(request.id);

		expect(requestMessage(h, request.id, 'https://agents.example.com')).toBeNull();
	});

	it('says nothing about a request that does not exist', () => {
		expect(requestMessage(h, 'nope', 'https://agents.example.com')).toBeNull();
	});
});

describe('the pusher on the bus', () => {
	it('sends when an agent stops, without the agent waiting for it', async () => {
		subscribe();
		const send = vi.fn().mockResolvedValue(undefined);
		const stop = startRequestPusher({
			context: () => h,
			bus: h.bus,
			settings,
			send,
			baseUrl: () => 'https://agents.example.com'
		});

		createRequest(h, { agentId, kind: 'confirm', question: 'Push to main?' });
		// The subscriber does its work off the publishing path, so the assertion has
		// to let the microtask queue drain first — which is the point being made.
		await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));

		expect(JSON.parse(send.mock.calls[0][1] as string)).toMatchObject({
			title: 'claude is waiting on you',
			body: 'Push to main?'
		});
		stop();
	});

	it('ignores every other event', async () => {
		subscribe();
		const send = vi.fn().mockResolvedValue(undefined);
		const stop = startRequestPusher({ context: () => h, bus: h.bus, settings, send });

		createProject(h, { name: 'Anything' });
		await Promise.resolve();

		expect(send).not.toHaveBeenCalled();
		stop();
	});

	it('stops sending once it is taken off the bus', async () => {
		subscribe();
		const send = vi.fn().mockResolvedValue(undefined);
		startRequestPusher({ context: () => h, bus: h.bus, settings, send })();

		createRequest(h, { agentId, kind: 'confirm', question: 'Push to main?' });
		await Promise.resolve();

		expect(send).not.toHaveBeenCalled();
	});
});

/**
 * Buttons on the notification itself (design §7).
 *
 * Whether a browser draws them is its own business — the payload carries them
 * either way, and tapping the body still opens the card. What is decided here is
 * which kinds may be answered in one tap at all, which is a safety question
 * rather than a rendering one.
 */
describe('notification actions', () => {
	const ask = (over: Record<string, unknown> = {}) =>
		createRequest(h, { agentId, kind: 'confirm', question: 'Push to main?', ...over }).request;

	const message = (over: Record<string, unknown> = {}) =>
		requestMessage(h, ask(over).id, 'https://agents.example.com');

	it('offers approve and reject on a confirm, with the booleans they send', () => {
		expect(message()?.actions).toEqual([
			{ action: 'confirm-yes', title: 'Approve', value: true },
			{ action: 'confirm-no', title: 'Reject', value: false }
		]);
	});

	it('offers a buttons request’s own labels', () => {
		const actions = message({
			kind: 'buttons',
			question: 'The build failed',
			options: ['retry', 'skip']
		})?.actions;

		expect(actions).toEqual([
			{ action: 'option-0', title: 'retry', value: 'retry' },
			{ action: 'option-1', title: 'skip', value: 'skip' }
		]);
	});

	it('stops at two, because a third is dropped silently by the browser', () => {
		const actions = message({
			kind: 'choice',
			question: 'Which branch?',
			options: ['main', 'next', 'release/1.2', 'none']
		})?.actions;

		expect(actions).toHaveLength(MAX_PUSH_ACTIONS);
		expect(actions?.map((a) => a.title)).toEqual(['main', 'next']);
	});

	it('offers none for a text request, which cannot be answered by a tap', () => {
		expect(message({ kind: 'text', question: 'Commit message?' })?.actions).toBeUndefined();
	});

	it('offers none for a multi_choice, where one tap cannot express the answer', () => {
		const built = message({
			kind: 'multi_choice',
			question: 'Delete which?',
			options: ['a', 'b']
		});

		expect(built?.actions).toBeUndefined();
	});

	it('offers none for a form: approving a draft nobody has read is the one real hazard', () => {
		const built = message({
			kind: 'form',
			question: 'Send this to #general?',
			options: ['Approve', 'Reject'],
			default: 'the draft'
		});

		expect(built?.actions).toBeUndefined();
	});

	it('carries the request id, so the worker can answer without opening a page', () => {
		const request = ask();

		expect(requestMessage(h, request.id, 'https://agents.example.com')?.requestId).toBe(request.id);
	});
});

/**
 * Per-device filtering (design §7).
 *
 * The rule that matters most is the default: a device that has never been
 * configured hears about everything. "Notify me" is what the owner clicked, and
 * a default that dropped two of the three kinds is indistinguishable from push
 * being broken — which is exactly how it was reported.
 */
describe('what one device wants to hear about', () => {
	it('defaults to everything, which is what the toggle promised', () => {
		// `comment` joined the list rather than replacing `message`: the two are
		// separate events now, and both are on until the owner says otherwise.
		expect(DEFAULT_PUSH_TYPES).toEqual(['request', 'update', 'message', 'comment']);
		expect(notifies(null, { type: 'request' })).toBe(true);
		expect(notifies(null, { type: 'update', level: 'error', priority: 'high' })).toBe(true);
		expect(notifies(null, { type: 'update', level: 'info', priority: 'low' })).toBe(true);
		expect(notifies(null, { type: 'message' })).toBe(true);
	});

	it('still lets a device narrow itself to questions only', () => {
		const prefs = { types: ['request'] };

		expect(notifies(prefs, { type: 'request' })).toBe(true);
		expect(notifies(prefs, { type: 'update', level: 'error', priority: 'high' })).toBe(false);
		expect(notifies(prefs, { type: 'message' })).toBe(false);
	});

	it('takes a type whitelist', () => {
		const prefs = { types: ['message'] };

		expect(notifies(prefs, { type: 'message' })).toBe(true);
		expect(notifies(prefs, { type: 'request' })).toBe(false);
	});

	it('filters updates by level', () => {
		const prefs = { types: ['update'], levels: ['error'] };

		expect(notifies(prefs, { type: 'update', level: 'error' })).toBe(true);
		expect(notifies(prefs, { type: 'update', level: 'info' })).toBe(false);
	});

	it('filters updates by priority', () => {
		const prefs = { types: ['update'], priorities: ['high'] };

		expect(notifies(prefs, { type: 'update', level: 'info', priority: 'high' })).toBe(true);
		expect(notifies(prefs, { type: 'update', level: 'info', priority: 'low' })).toBe(false);
	});

	it('applies level and priority together, both having to pass', () => {
		const prefs = { types: ['update'], levels: ['error'], priorities: ['high'] };

		expect(notifies(prefs, { type: 'update', level: 'error', priority: 'high' })).toBe(true);
		expect(notifies(prefs, { type: 'update', level: 'error', priority: 'low' })).toBe(false);
		expect(notifies(prefs, { type: 'update', level: 'info', priority: 'high' })).toBe(false);
	});

	it('never applies level or priority to a question, which has neither', () => {
		const prefs = { types: ['request'], levels: ['error'], priorities: ['high'] };

		expect(notifies(prefs, { type: 'request' })).toBe(true);
	});

	it('sends only to the devices that asked for it', async () => {
		subscribe('https://push.example/phone');
		subscribe('https://push.example/laptop');
		setDevicePrefs(h, 'https://push.example/phone', { types: ['request'] });
		setDevicePrefs(h, 'https://push.example/laptop', { types: ['request', 'update'] });
		const send = vi.fn().mockResolvedValue(undefined);

		await sendPush(
			h,
			{ title: 't', body: 'b', url: '/', tag: 'x' },
			{
				about: { type: 'update', level: 'info', priority: 'medium' },
				settings,
				send
			}
		);

		expect(send.mock.calls.map((call) => call[0].endpoint)).toEqual([
			'https://push.example/laptop'
		]);
	});
});

describe('storing preferences', () => {
	it('keeps only what it understands, and refuses the rest', () => {
		expect(assertPushPrefs({ types: ['request', 'update'] })).toEqual({
			types: ['request', 'update']
		});
		expect(() => assertPushPrefs({ types: ['everything'] })).toThrow(/types must be any of/);
		expect(() => assertPushPrefs({ levels: ['catastrophe'] })).toThrow(/levels must be any of/);
		expect(() => assertPushPrefs({ priorities: ['urgent'] })).toThrow(/priorities must be any of/);
		expect(() => assertPushPrefs({ types: 'request' })).toThrow(/must be a list/);
		expect(() => assertPushPrefs(['request'])).toThrow(/must be an object/);
	});

	it('drops duplicates rather than storing a list that repeats itself', () => {
		expect(assertPushPrefs({ types: ['request', 'request'] })).toEqual({ types: ['request'] });
	});

	it('treats an empty object and null alike: back to the default', () => {
		expect(assertPushPrefs({})).toBeNull();
		expect(assertPushPrefs(null)).toBeNull();
	});

	it('refuses to configure a device that is not subscribed', () => {
		expect(() => setDevicePrefs(h, 'https://push.example/gone', { types: ['update'] })).toThrow(
			/no such subscription/
		);
	});

	it('survives a browser re-subscribing, which passes no preferences', () => {
		subscribe();
		setDevicePrefs(h, 'https://push.example/one', { types: ['update'] });

		subscribe();

		expect(findPushSubscription(h.db, 'https://push.example/one')?.prefs).toEqual({
			types: ['update']
		});
	});
});

/**
 * Replies and comments are two events (#feedback: "commenting is just replying
 * to a thread, to anyone; replying is specifically replying to me").
 *
 * A phone that buzzes the same way for both teaches its owner to ignore the one
 * that was aimed at them. The distinction is derived rather than declared,
 * because an agent asked to classify its own message would get it wrong in both
 * directions — generously, at 2am.
 */
describe('telling a reply from a comment', () => {
	const BASE = 'https://dash.example';
	let slug: string;
	let updateId: string;

	beforeEach(() => {
		slug = createProject(h, { name: 'Agent Dashboard' }).project.slug;
		updateId = postUpdate(h, { project: slug, agentId, body: 'shipped it' }).id;
	});

	const fromAgent = (scope: Record<string, string>) =>
		postMessage(h, { author: { kind: 'agent', agentId }, body: 'here you go', ...scope });

	const fromOwner = (scope: Record<string, string>) =>
		postMessage(h, { author: { kind: 'human' }, body: 'have a look', ...scope });

	/** The domain names the anchor `updateId`, not `update`. */
	const onCard = () => ({ updateId });

	it('calls an answer under the owner’s own post a reply', () => {
		const post = fromOwner({ project: slug });
		const answer = fromAgent({ replyTo: post.id });

		expect(repliesToOwner(h, answer)).toBe(true);
		expect(replyMessage(h, answer.id, BASE)?.about.type).toBe('message');
	});

	it('calls a message in a thread the owner spoke in a reply', () => {
		fromOwner(onCard());
		const answer = fromAgent(onCard());

		expect(repliesToOwner(h, answer)).toBe(true);
	});

	it('calls a note on a card the owner never touched a comment', () => {
		const note = fromAgent(onCard());

		expect(repliesToOwner(h, note)).toBe(false);
		expect(replyMessage(h, note.id, BASE)?.about.type).toBe('comment');
	});

	it('calls one agent answering another a comment, not a reply to the owner', () => {
		const other = h.agent('other');
		postMessage(h, { author: { kind: 'agent', agentId: other }, body: 'a note', updateId });
		const answer = fromAgent(onCard());

		expect(repliesToOwner(h, answer)).toBe(false);
	});

	it('calls a bare project note a comment: it answers nobody', () => {
		const note = fromAgent({ project: slug });

		expect(repliesToOwner(h, note)).toBe(false);
	});

	it('says which it is in the title, so the phone screen carries the difference', () => {
		const post = fromOwner({ project: slug });
		const reply = fromAgent({ replyTo: post.id });
		const comment = fromAgent(onCard());

		expect(replyMessage(h, reply.id, BASE)?.message.title).toBe('claude replied to you');
		expect(replyMessage(h, comment.id, BASE)?.message.title).toBe('claude commented');
	});

	it('lets a device take the replies and leave the comments', () => {
		expect(notifies({ types: ['message'] }, { type: 'message' })).toBe(true);
		expect(notifies({ types: ['message'] }, { type: 'comment' })).toBe(false);
	});

	it('still says nothing about the owner’s own messages', () => {
		const post = fromOwner({ project: slug });

		expect(replyMessage(h, post.id, BASE)).toBeNull();
	});
});
