import { setStatus } from './cards';
import { postUpdate } from './updates';
import { createProject } from './projects';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findOwnerDeviceById } from '$db';
import type { ApnsRequest, ApnsResponse, ApnsTransport } from './apns';
import { mintOwnerDevice, setDeviceApnsToken, setDeviceLiveActivityTokens } from './devices';
import {
	createLiveActivityPusher,
	LIVE_ACTIVITY_ATTRIBUTES_TYPE,
	type LiveActivityPusher
} from './live-activity';
import { answerRequest, createRequest } from './requests';
import { registerSession } from './sessions';
import { FIXED_NOW, harness, type Harness } from './testing';

const SETTINGS = {
	keyId: 'KEY123',
	teamId: 'TEAM456',
	keyPath: '/keys/apns.p8',
	bundleId: 'dev.wildware.agents'
};

let h: Harness;
let agentId: string;
let deviceId: string;
let sent: ApnsRequest[];
let respond: (request: ApnsRequest) => ApnsResponse;
let pusher: LiveActivityPusher;

const transport: ApnsTransport = (request) => {
	sent.push(request);
	return Promise.resolve(respond(request));
};

const payloads = () => sent.map((request) => JSON.parse(request.payload));

beforeEach(() => {
	h = harness();
	agentId = h.agent('scout');
	sent = [];
	respond = () => ({ status: 200, reason: null });
	deviceId = mintOwnerDevice(h, { name: 'phone', secret: 't'.repeat(32) }).device.id;
	setDeviceApnsToken(h, deviceId, { token: 'aaaa', environment: 'sandbox' });
	pusher = createLiveActivityPusher({
		context: () => h,
		bus: h.bus,
		settings: () => SETTINGS,
		transport,
		baseUrl: () => 'https://dash.test'
	});
});

afterEach(() => {
	pusher.stop();
	vi.useRealTimers();
});

describe('updating a running Live Activity', () => {
	beforeEach(() => {
		setDeviceLiveActivityTokens(h, deviceId, { updateToken: 'beef' });
	});

	it('sends the current state to the activity token, on the liveactivity topic', async () => {
		const request = createRequest(h, { agentId, kind: 'confirm', question: 'ship?' }).request;
		await pusher.flush();

		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({
			environment: 'sandbox',
			deviceToken: 'beef',
			headers: {
				'apns-push-type': 'liveactivity',
				'apns-topic': 'dev.wildware.agents.push-type.liveactivity',
				'apns-priority': '10'
			}
		});
		expect(payloads()[0]).toEqual({
			aps: {
				timestamp: Math.floor(FIXED_NOW / 1000),
				event: 'update',
				'content-state': {
					online: 0,
					waiting: 1,
					inProgress: 0,
					topAgent: 'scout',
					topQuestion: 'ship?',
					topRequestId: request.id,
					topKind: 'confirm',
					topAgentId: agentId,
					topProject: null,
					topExpiresAt: Math.floor(request.expiresAt / 1000),
					topOptions: null,
					topDefault: null,
					working: null
				}
			}
		});
	});

	it('sends again when a card goes in progress, with what is being worked on', async () => {
		createProject(h, { name: 'Garden', slug: 'garden' });
		const update = postUpdate(h, { project: 'garden', agentId, title: 'Fixing fees', body: 'x' });
		await pusher.flush();
		setStatus(h, { card: { kind: 'update', id: update.id }, status: 'in_progress' });
		await pusher.flush();

		expect(payloads().at(-1)!.aps['content-state']).toMatchObject({
			inProgress: 1,
			working: [
				{ agentId, agent: 'scout', task: 'Fixing fees', since: Math.floor(FIXED_NOW / 1000) }
			]
		});
	});

	it('sends nothing when the state has not changed', async () => {
		createRequest(h, { agentId, kind: 'confirm', question: 'ship?' });
		await pusher.flush();
		await pusher.flush();

		expect(sent).toHaveLength(1);
	});

	it('sends again once the request is answered', async () => {
		const request = createRequest(h, { agentId, kind: 'confirm', question: 'ship?' }).request;
		await pusher.flush();
		answerRequest(h, { requestId: request.id, value: true });
		await pusher.flush();

		expect(payloads()[1].aps['content-state']).toMatchObject({
			waiting: 0,
			topRequestId: null,
			topKind: null
		});
		expect(sent[1].headers['apns-priority']).toBe('10');
	});

	it('sends a count-only change at low priority while nobody is waiting', async () => {
		await pusher.flush();
		registerSession(h, { agentId });
		await pusher.flush();

		expect(payloads()[1].aps['content-state']).toMatchObject({ online: 1, waiting: 0 });
		expect(sent[1].headers['apns-priority']).toBe('5');
	});

	it('forgets an activity token Apple says is gone', async () => {
		respond = () => ({ status: 410, reason: 'Unregistered' });
		await pusher.flush();

		expect(findOwnerDeviceById(h.db, deviceId)?.liveActivityToken).toBeNull();
	});

	it('coalesces a burst of changes into one push', async () => {
		vi.useFakeTimers();
		pusher.stop();
		pusher = createLiveActivityPusher({
			context: () => h,
			bus: h.bus,
			settings: () => SETTINGS,
			transport,
			coalesceMs: 2_000
		});

		createRequest(h, { agentId, kind: 'confirm', question: 'one?' });
		createRequest(h, { agentId, kind: 'confirm', question: 'two?' });
		registerSession(h, { agentId });
		expect(sent).toHaveLength(0);

		await vi.advanceTimersByTimeAsync(2_000);
		await pusher.flush();

		expect(sent).toHaveLength(1);
		expect(payloads()[0].aps['content-state']).toMatchObject({ online: 1, waiting: 2 });
	});
});

describe('starting a Live Activity by push', () => {
	beforeEach(() => {
		setDeviceLiveActivityTokens(h, deviceId, { updateToken: null, pushToStartToken: 'cafe' });
	});

	it('starts one when a request arrives and none is running', async () => {
		createRequest(h, { agentId, kind: 'confirm', question: 'ship?' });
		await pusher.flush();

		expect(sent).toHaveLength(1);
		expect(sent[0].deviceToken).toBe('cafe');
		expect(payloads()[0].aps).toMatchObject({
			event: 'start',
			'attributes-type': LIVE_ACTIVITY_ATTRIBUTES_TYPE,
			attributes: {},
			alert: { title: 'scout is waiting on you', body: 'ship?' },
			'content-state': { waiting: 1, topQuestion: 'ship?', topAgentId: agentId, working: null }
		});
		// Every key the update carries, and never the phone's own `sentAnswer`.
		expect(Object.keys(payloads()[0].aps['content-state'])).toEqual([
			'online',
			'waiting',
			'inProgress',
			'topAgent',
			'topQuestion',
			'topRequestId',
			'topKind',
			'topAgentId',
			'topProject',
			'topExpiresAt',
			'topOptions',
			'topDefault',
			'working'
		]);
	});

	it('does not start one again straight after', async () => {
		createRequest(h, { agentId, kind: 'confirm', question: 'one?' });
		await pusher.flush();
		createRequest(h, { agentId, kind: 'confirm', question: 'two?' });
		await pusher.flush();

		expect(sent).toHaveLength(1);
	});

	it('does not start one for anything but a new request', async () => {
		registerSession(h, { agentId });
		await pusher.flush();

		expect(sent).toEqual([]);
	});

	it('does not start one over a running activity', async () => {
		setDeviceLiveActivityTokens(h, deviceId, { updateToken: 'beef' });
		createRequest(h, { agentId, kind: 'confirm', question: 'ship?' });
		await pusher.flush();

		expect(sent.map((request) => request.deviceToken)).toEqual(['beef']);
	});
});

it('sends nothing when APNs is not configured', async () => {
	pusher.stop();
	setDeviceLiveActivityTokens(h, deviceId, { updateToken: 'beef', pushToStartToken: 'cafe' });
	pusher = createLiveActivityPusher({
		context: () => h,
		bus: h.bus,
		settings: () => null,
		transport
	});

	createRequest(h, { agentId, kind: 'confirm', question: 'ship?' });
	await pusher.flush();

	expect(sent).toEqual([]);
});
