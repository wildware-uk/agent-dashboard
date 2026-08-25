import { describe, expect, it } from 'vitest';
import { EventBus } from '$events';
import { registerSession } from '$domain';
import { harness } from '$domain/testing';
import { SESSION_COOKIE, signSession } from '../auth';
import { readAgentsSnapshot } from './agents';
import { createSnapshotHandler } from './snapshot';

const SESSION_SECRET = 's'.repeat(32);
const config = () => ({ sessionSecret: SESSION_SECRET, adminPasswordHash: '$argon2id$x' });

/** The route as `routes/api/snapshot/agents/+server.ts` mounts it. */
async function get(options: { cookie?: string; bus?: EventBus; ctx?: ReturnType<typeof harness> }) {
	const ctx = options.ctx;
	const handler = createSnapshotHandler({
		bus: options.bus ?? new EventBus(),
		config,
		read: () => readAgentsSnapshot(ctx)
	});
	const url = new URL('http://dash.test/api/snapshot/agents');
	const cookie = options.cookie ?? signSession(SESSION_SECRET);
	const response = handler({
		request: new Request(url),
		url,
		cookies: { get: (name: string) => (name === SESSION_COOKIE ? cookie : undefined) }
	});

	return { response, body: await response.json() };
}

describe('readAgentsSnapshot', () => {
	it('answers with the live agents and their session metadata', () => {
		const h = harness();
		const agentId = h.agent('scout');
		registerSession(h, { agentId, meta: { host: 'wildware', cwd: '/srv', model: 'opus' } });

		expect(readAgentsSnapshot(h)).toEqual({
			agents: [
				{
					agentId,
					name: 'scout',
					sessionId: expect.any(String),
					startedAt: expect.any(Number),
					lastHeartbeatAt: expect.any(Number),
					sessions: 1,
					host: 'wildware',
					cwd: '/srv',
					model: 'opus'
				}
			]
		});
	});

	it('answers with nobody rather than failing when no agent has ever registered', () => {
		expect(readAgentsSnapshot(harness())).toEqual({ agents: [] });
	});
});

describe('GET /api/snapshot/agents', () => {
	it('stamps the state with the stream cursor it is good to', async () => {
		const bus = new EventBus();
		const h = harness();
		registerSession(h, { agentId: h.agent('scout') });
		bus.publish('agent.presence', { agentId: 'a1', sessionId: 's1', online: true });

		const { response, body } = await get({ bus, ctx: h });

		expect(response.status).toBe(200);
		expect(body.seq).toBe(bus.lastSeq);
		expect(body.agents).toHaveLength(1);
	});

	it('is no more readable than the stream: no session, no answer', async () => {
		const { response, body } = await get({ cookie: 'forged', ctx: harness() });

		expect(response.status).toBe(401);
		expect(body).toEqual({ error: 'unauthenticated' });
	});

	it('is never cached, because it is only true for a moment', async () => {
		const { response } = await get({ ctx: harness() });

		expect(response.headers.get('cache-control')).toContain('no-store');
	});
});
