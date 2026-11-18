import { generateKeyPairSync, verify } from 'node:crypto';
import {
	connect,
	createServer,
	type ClientHttp2Session,
	type Http2Server,
	type ServerHttp2Session,
	type IncomingHttpHeaders
} from 'node:http2';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findOwnerDeviceById } from '$db';
import {
	alertHeaders,
	alertPayload,
	CRITICAL_STYLE,
	MARKDOWN_MAX_BYTES,
	apnsAlertFor,
	createApnsTransport,
	createProviderTokenSigner,
	deliverToDevice,
	PROVIDER_TOKEN_TTL_MS,
	sendApnsAlert,
	startApnsPusher,
	truncateBytes,
	type ApnsRequest,
	type ApnsResponse,
	type ApnsTransport
} from './apns';
import {
	mintOwnerDevice,
	setDeviceAlertPrefs,
	setDeviceAlertProjects,
	setDeviceApnsToken
} from './devices';
import { listThread, postMessage } from './messages';
import { createProject } from './projects';
import { createRequest } from './requests';
import { FIXED_NOW, harness, type Harness } from './testing';
import { postUpdate } from './updates';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const SETTINGS = {
	keyId: 'KEY123',
	teamId: 'TEAM456',
	keyPath: '/keys/apns.p8',
	bundleId: 'dev.wildware.agents'
};
const BASE = 'https://dash.test';

function decode(part: string): Record<string, unknown> {
	return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

describe('the provider token', () => {
	it('is an ES256 JWT naming the key and team, signed with the p8 key', () => {
		const signer = createProviderTokenSigner(SETTINGS, () => PEM);
		const [header, claims, signature] = signer.token(FIXED_NOW).split('.');

		expect(decode(header)).toEqual({ alg: 'ES256', kid: 'KEY123' });
		expect(decode(claims)).toEqual({ iss: 'TEAM456', iat: Math.floor(FIXED_NOW / 1000) });
		expect(
			verify(
				'sha256',
				Buffer.from(`${header}.${claims}`),
				{ key: publicKey, dsaEncoding: 'ieee-p1363' },
				Buffer.from(signature, 'base64url')
			)
		).toBe(true);
	});

	it('is reused for fifty minutes, then signed again', () => {
		const readKey = vi.fn(() => PEM);
		const signer = createProviderTokenSigner(SETTINGS, readKey);
		const first = signer.token(FIXED_NOW);

		expect(signer.token(FIXED_NOW + PROVIDER_TOKEN_TTL_MS - 1)).toBe(first);
		expect(signer.token(FIXED_NOW + PROVIDER_TOKEN_TTL_MS)).not.toBe(first);
		expect(readKey).toHaveBeenCalledTimes(1);
	});

	it('is signed again after being invalidated', () => {
		const signer = createProviderTokenSigner(SETTINGS, () => PEM);
		const first = signer.token(FIXED_NOW);
		signer.invalidate();

		expect(signer.token(FIXED_NOW)).not.toBe(first);
	});
});

describe('the HTTP/2 transport', () => {
	let server: Http2Server;
	let port: number;
	let seen: { headers: IncomingHttpHeaders; body: string }[];
	let answer: { status: number; body?: string };
	let sessions: Set<ServerHttp2Session>;

	beforeEach(async () => {
		seen = [];
		answer = { status: 200 };
		sessions = new Set();
		server = createServer();
		server.on('session', (session) => {
			sessions.add(session);
			session.on('close', () => sessions.delete(session));
		});
		server.on('stream', (stream, headers) => {
			let body = '';
			stream.on('data', (chunk) => (body += chunk));
			stream.on('end', () => {
				seen.push({ headers, body });
				stream.respond({ ':status': answer.status });
				stream.end(answer.body ?? '');
			});
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		port = (server.address() as AddressInfo).port;
	});

	afterEach(async () => {
		// The transport keeps its session open for reuse, which is the point of it.
		// Node 22's `server.close()` waits for every open session to end (Node 24
		// closes idle ones itself), so the test closes them as well.
		const closed = new Promise<void>((resolve) => server.close(() => resolve()));
		for (const session of sessions) session.close();
		await closed;
	});

	const transport = (opened: string[] = []) =>
		createApnsTransport(SETTINGS, {
			readKey: () => PEM,
			now: () => FIXED_NOW,
			connect: (authority) => {
				opened.push(authority);
				return connect(`http://127.0.0.1:${port}`);
			}
		});

	const request = (over: Partial<ApnsRequest> = {}): ApnsRequest => ({
		environment: 'production',
		deviceToken: 'abcd',
		headers: { 'apns-topic': 'dev.wildware.agents' },
		payload: '{"aps":{}}',
		...over
	});

	it('posts the payload to /3/device/<token> with the provider token', async () => {
		const opened: string[] = [];
		const send = transport(opened);

		await expect(send(request())).resolves.toEqual({ status: 200, reason: null });

		expect(opened).toEqual(['https://api.push.apple.com']);
		expect(seen[0].headers).toMatchObject({
			':method': 'POST',
			':path': '/3/device/abcd',
			'apns-topic': 'dev.wildware.agents',
			'content-type': 'application/json'
		});
		expect(String(seen[0].headers.authorization)).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
		expect(seen[0].body).toBe('{"aps":{}}');
	});

	it('picks the sandbox host for a sandbox device and reuses one session per host', async () => {
		const opened: string[] = [];
		const send = transport(opened);

		await send(request({ environment: 'sandbox' }));
		await send(request({ environment: 'sandbox' }));

		expect(opened).toEqual(['https://api.sandbox.push.apple.com']);
	});

	it('reads the reason Apple gives for a refusal', async () => {
		answer = { status: 400, body: '{"reason":"BadDeviceToken"}' };

		await expect(transport()(request())).resolves.toEqual({
			status: 400,
			reason: 'BadDeviceToken'
		});
	});

	it('signs a fresh provider token after Apple calls the old one expired', async () => {
		const send = transport();
		answer = { status: 403, body: '{"reason":"ExpiredProviderToken"}' };
		await send(request());
		answer = { status: 200 };
		await send(request());

		expect(seen[1].headers.authorization).not.toBe(seen[0].headers.authorization);
	});

	it('never keeps the process alive: an idle session to Apple must not hold up a shutdown', async () => {
		const sessions: ClientHttp2Session[] = [];
		const send = createApnsTransport(SETTINGS, {
			readKey: () => PEM,
			connect: () => {
				const session = connect(`http://127.0.0.1:${port}`);
				sessions.push(session);
				vi.spyOn(session, 'unref');
				return session;
			}
		});

		await send(request());

		expect(sessions[0].unref).toHaveBeenCalled();
	});

	it('opens a new session once the old one is gone', async () => {
		const sessions: ClientHttp2Session[] = [];
		const send = createApnsTransport(SETTINGS, {
			readKey: () => PEM,
			connect: () => {
				const session = connect(`http://127.0.0.1:${port}`);
				sessions.push(session);
				return session;
			}
		});
		await send(request());

		await new Promise<void>((resolve) => {
			sessions[0].once('close', () => resolve());
			sessions[0].destroy();
		});
		await expect(send(request())).resolves.toMatchObject({ status: 200 });

		expect(sessions).toHaveLength(2);
	});
});

describe('one delivery', () => {
	let h: Harness;
	let deviceId: string;

	beforeEach(() => {
		h = harness();
		deviceId = mintOwnerDevice(h, { name: 'phone', secret: 't'.repeat(32) }).device.id;
		setDeviceApnsToken(h, deviceId, { token: 'aaaa', environment: 'sandbox' });
	});

	const device = () => findOwnerDeviceById(h.db, deviceId)!;
	const answering =
		(response: ApnsResponse): ApnsTransport =>
		() =>
			Promise.resolve(response);

	it('is sent to the device’s own environment', async () => {
		const calls: ApnsRequest[] = [];
		const transport: ApnsTransport = (request) => {
			calls.push(request);
			return Promise.resolve({ status: 200, reason: null });
		};

		await expect(
			deliverToDevice(h, transport, device(), 'apns_token', {}, { aps: {} })
		).resolves.toBe('sent');
		expect(calls[0]).toMatchObject({ environment: 'sandbox', deviceToken: 'aaaa' });
	});

	it.each([
		[410, null],
		[400, 'BadDeviceToken'],
		[400, 'DeviceTokenNotForTopic']
	])('clears the token on %i %s', async (status, reason) => {
		await expect(
			deliverToDevice(h, answering({ status, reason }), device(), 'apns_token', {}, {})
		).resolves.toBe('removed');
		expect(device().apnsToken).toBeNull();
	});

	it('counts any other refusal and keeps the token', async () => {
		await expect(
			deliverToDevice(
				h,
				answering({ status: 429, reason: 'TooManyRequests' }),
				device(),
				'apns_token',
				{},
				{}
			)
		).resolves.toBe('failed');
		expect(device()).toMatchObject({ apnsToken: 'aaaa', failures: 1 });
	});

	it('never throws, even when the transport does', async () => {
		const onError = vi.fn();
		const broken: ApnsTransport = () => Promise.reject(new Error('socket hang up'));

		await expect(deliverToDevice(h, broken, device(), 'apns_token', {}, {}, onError)).resolves.toBe(
			'failed'
		);
		expect(onError).toHaveBeenCalledOnce();
	});
});

describe('the alert', () => {
	let h: Harness;
	let agentId: string;

	beforeEach(() => {
		h = harness();
		agentId = h.agent('scout');
		createProject(h, { name: 'Fees', slug: 'fees' });
	});

	it('carries what is needed to answer a request without opening the app', () => {
		const request = createRequest(h, {
			agentId,
			kind: 'buttons',
			question: 'deploy now?',
			options: ['yes', 'later'],
			project: 'fees'
		}).request;

		const alert = apnsAlertFor(h, { type: 'request.created', requestId: request.id }, BASE)!;

		expect(alertPayload(alert)).toEqual({
			aps: {
				alert: { title: 'scout is waiting on you', body: 'deploy now?' },
				sound: 'default',
				'thread-id': 'fees',
				category: 'REQUEST',
				'mutable-content': 1,
				'interruption-level': 'time-sensitive'
			},
			url: `${BASE}/projects/fees?focus=${request.id}`,
			tag: `request-${request.id}`,
			requestId: request.id,
			requestKind: 'buttons',
			options: ['yes', 'later'],
			markdown: 'deploy now?'
		});
	});

	it('sends the markdown as written beside the plain alert, cut to fit Apple’s limit', () => {
		const update = postUpdate(h, {
			project: 'fees',
			agentId,
			body: `**Deployed.** ${'x'.repeat(3000)}`
		});

		const payload = alertPayload(
			apnsAlertFor(h, { type: 'update.created', updateId: update.id }, BASE)!
		);

		expect(payload.markdown).toMatch(/^\*\*Deployed\.\*\* x/);
		expect(Buffer.byteLength(payload.markdown as string)).toBe(MARKDOWN_MAX_BYTES);
		expect((payload.aps as { alert: { body: string } }).alert.body).toMatch(/^Deployed\. x/);
		expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(4096);
	});

	it('names the update to reply on', () => {
		const update = postUpdate(h, { project: 'fees', agentId, body: 'deployed' });

		const payload = alertPayload(
			apnsAlertFor(h, { type: 'update.created', updateId: update.id }, BASE)!
		);

		expect(payload).toMatchObject({
			aps: { category: 'UPDATE', 'thread-id': 'fees', 'interruption-level': 'active' },
			reply: { update: update.id }
		});
		expect(payload).not.toHaveProperty('requestId');
		expect(payload.aps).not.toHaveProperty('mutable-content');
	});

	it('gives a message a reply that lands in the same thread', () => {
		const update = postUpdate(h, { project: 'fees', agentId, body: 'deployed' });
		const said = postMessage(h, {
			author: { kind: 'agent', agentId },
			body: 'done, check it',
			updateId: update.id
		});

		const alert = apnsAlertFor(h, { type: 'message.created', messageId: said.id }, BASE)!;
		expect(alertPayload(alert)).toMatchObject({ aps: { category: 'MESSAGE' } });

		const reply = postMessage(h, {
			author: { kind: 'human' },
			body: 'thanks',
			...(alert.reply as { answers: string })
		});
		expect(reply.updateId).toBe(update.id);
		expect(listThread(h, { updateId: update.id }).map((message) => message.id)).toContain(reply.id);
	});

	it('is not sent for the owner’s own message', () => {
		const said = postMessage(h, { author: { kind: 'human' }, body: 'hi', project: 'fees' });

		expect(apnsAlertFor(h, { type: 'message.created', messageId: said.id }, BASE)).toBeNull();
	});

	it('uses Apple’s headers, with the tag as a collapse id cut to 64 bytes', () => {
		expect(alertHeaders('dev.wildware.agents', 'x'.repeat(80), FIXED_NOW)).toEqual({
			'apns-push-type': 'alert',
			'apns-topic': 'dev.wildware.agents',
			'apns-priority': '10',
			'apns-expiration': String(Math.floor(FIXED_NOW / 1000) + 900),
			'apns-collapse-id': 'x'.repeat(64)
		});
		expect(Buffer.byteLength(truncateBytes('é'.repeat(40), 64))).toBe(64);
		expect(truncateBytes('aé', 2)).toBe('a');
	});
});

describe('the alert sender', () => {
	let h: Harness;
	let agentId: string;
	let sent: ApnsRequest[];
	const transport: ApnsTransport = (request) => {
		sent.push(request);
		return Promise.resolve({ status: 200, reason: null });
	};

	beforeEach(() => {
		h = harness();
		agentId = h.agent('scout');
		sent = [];
		const phone = mintOwnerDevice(h, { name: 'phone', secret: 't'.repeat(32) }).device;
		setDeviceApnsToken(h, phone.id, { token: 'aaaa', environment: 'production' });
		mintOwnerDevice(h, { name: 'no push', secret: 't'.repeat(32) });
	});

	it('sends to every device with an alert token', async () => {
		const request = createRequest(h, { agentId, kind: 'confirm', question: 'ok?' }).request;
		const alert = apnsAlertFor(h, { type: 'request.created', requestId: request.id }, BASE)!;

		await expect(sendApnsAlert(h, alert, { settings: SETTINGS, transport })).resolves.toEqual({
			sent: 1,
			removed: 0,
			failed: 0
		});
		expect(sent[0].headers['apns-topic']).toBe('dev.wildware.agents');
	});

	it('sends a phone only the kinds and levels of alert it asked for', async () => {
		createProject(h, { name: 'Fees', slug: 'fees' });
		const picky = mintOwnerDevice(h, { name: 'picky', secret: 't'.repeat(32) }).device;
		setDeviceApnsToken(h, picky.id, { token: 'cccc', environment: 'production' });
		setDeviceAlertPrefs(h, picky.id, { types: ['request', 'update'], levels: ['error'] });
		const stop = startApnsPusher({
			context: () => h,
			bus: h.bus,
			settings: () => SETTINGS,
			transport,
			baseUrl: () => BASE
		});
		const deliveredTo = async (post: () => void) => {
			sent = [];
			post();
			await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));
			await new Promise((resolve) => setTimeout(resolve, 10));
			return sent.map((request) => request.deviceToken).sort();
		};

		await expect(
			deliveredTo(() =>
				postUpdate(h, { project: 'fees', agentId, body: 'all fine', level: 'info' })
			)
		).resolves.toEqual(['aaaa']);
		await expect(
			deliveredTo(() =>
				postUpdate(h, { project: 'fees', agentId, body: 'it broke', level: 'error' })
			)
		).resolves.toEqual(['aaaa', 'cccc']);
		await expect(
			deliveredTo(() => createRequest(h, { agentId, kind: 'confirm', question: 'ship?' }))
		).resolves.toEqual(['aaaa', 'cccc']);
		stop();
	});

	it('sends a phone limited to some projects only their alerts, and project-less ones', async () => {
		createProject(h, { name: 'Fees', slug: 'fees' });
		createProject(h, { name: 'Docs', slug: 'docs' });
		const focused = mintOwnerDevice(h, { name: 'focused', secret: 't'.repeat(32) }).device;
		setDeviceApnsToken(h, focused.id, { token: 'bbbb', environment: 'production' });
		setDeviceAlertProjects(h, focused.id, ['fees']);
		const stop = startApnsPusher({
			context: () => h,
			bus: h.bus,
			settings: () => SETTINGS,
			transport,
			baseUrl: () => BASE
		});
		const deliveredTo = async (post: () => void) => {
			sent = [];
			post();
			await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));
			await new Promise((resolve) => setTimeout(resolve, 10));
			return sent.map((request) => request.deviceToken).sort();
		};

		await expect(
			deliveredTo(() => postUpdate(h, { project: 'docs', agentId, body: 'docs done' }))
		).resolves.toEqual(['aaaa']);
		await expect(
			deliveredTo(() =>
				createRequest(h, { agentId, kind: 'confirm', question: 'fees?', project: 'fees' })
			)
		).resolves.toEqual(['aaaa', 'bbbb']);
		await expect(
			deliveredTo(() => createRequest(h, { agentId, kind: 'confirm', question: 'anywhere?' }))
		).resolves.toEqual(['aaaa', 'bbbb']);
		const update = postUpdate(h, { project: 'docs', agentId, body: 'docs again' });
		await expect(
			deliveredTo(() =>
				postMessage(h, { author: { kind: 'agent', agentId }, body: 'see?', updateId: update.id })
			)
		).resolves.toEqual(['aaaa']);
		stop();
	});

	it('answers the same events Web Push does, once APNs is configured', async () => {
		const stop = startApnsPusher({
			context: () => h,
			bus: h.bus,
			settings: () => SETTINGS,
			transport,
			baseUrl: () => BASE
		});
		createRequest(h, { agentId, kind: 'confirm', question: 'ok?' });

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(JSON.parse(sent[0].payload).aps.category).toBe('REQUEST');
		stop();
	});

	it('does nothing when APNs is not configured', async () => {
		const stop = startApnsPusher({
			context: () => h,
			bus: h.bus,
			settings: () => null,
			transport,
			baseUrl: () => BASE
		});
		createRequest(h, { agentId, kind: 'confirm', question: 'ok?' });
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(sent).toEqual([]);
		stop();
	});
});

describe('a critical alert', () => {
	let h: Harness;
	let agentId: string;
	let sent: ApnsRequest[];
	const transport: ApnsTransport = (request) => {
		sent.push(request);
		return Promise.resolve({ status: 200, reason: null });
	};
	const levelFor = (token: string) =>
		JSON.parse(sent.find((request) => request.deviceToken === token)!.payload).aps[
			'interruption-level'
		];

	beforeEach(() => {
		h = harness();
		agentId = h.agent('scout');
		sent = [];
		createProject(h, { name: 'Fees', slug: 'fees' });
		const pager = mintOwnerDevice(h, { name: 'pager', secret: 't'.repeat(32) }).device;
		setDeviceApnsToken(h, pager.id, { token: 'abab', environment: 'production' });
		setDeviceAlertPrefs(h, pager.id, { critical: true });
		const plain = mintOwnerDevice(h, { name: 'plain', secret: 't'.repeat(32) }).device;
		setDeviceApnsToken(h, plain.id, { token: 'cdcd', environment: 'production' });
	});

	const send = async (priority: 'high' | 'critical') => {
		const update = postUpdate(h, {
			project: 'fees',
			agentId,
			body: 'prod is down',
			level: 'error',
			priority
		});
		const alert = apnsAlertFor(h, { type: 'update.created', updateId: update.id }, BASE)!;
		await sendApnsAlert(h, alert, { settings: SETTINGS, transport });
	};

	it('breaks through on a phone that turned critical alerts on, and is a normal alert elsewhere', async () => {
		expect(CRITICAL_STYLE).toBe('time-sensitive');
		await send('critical');
		expect(levelFor('abab')).toBe('time-sensitive');
		expect(levelFor('cdcd')).toBe('active');
	});

	it('is never made of a high-priority update', async () => {
		await send('high');
		expect(levelFor('abab')).toBe('active');
	});

	it('marks the alert as critical for the app', async () => {
		await send('critical');
		expect(JSON.parse(sent[0].payload).priority).toBe('critical');
	});

	it('becomes an Apple critical alert, loud through silent mode, in one switch', () => {
		const update = postUpdate(h, {
			project: 'fees',
			agentId,
			body: 'prod is down',
			priority: 'critical'
		});
		const alert = apnsAlertFor(h, { type: 'update.created', updateId: update.id }, BASE)!;
		const aps = alertPayload(alert, { page: 'critical' }).aps as Record<string, unknown>;
		expect(aps['interruption-level']).toBe('critical');
		expect(aps.sound).toEqual({ critical: 1, name: 'default', volume: 1 });
	});
});
