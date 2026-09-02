import { beforeEach, describe, expect, it } from 'vitest';
import { createProject, postUpdate, startNotificationRecorder } from '$domain';
import { harness, type Harness } from '$domain/testing';
import { SESSION_COOKIE, signSession } from '../auth';
import {
	listNotificationsHandler,
	markNotificationsSeenHandler,
	type OwnerHandler
} from './notifications';

/**
 * The bell's two endpoints (migration 021).
 *
 * What matters below the browser: they are the owner's alone, the list carries
 * somewhere to click, and clearing one does not clear the rest.
 */

const SESSION_SECRET = 's'.repeat(32);
const config = () => ({ sessionSecret: SESSION_SECRET, adminPasswordHash: '$argon2id$x' });

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

async function call(
	factory: (options: object) => OwnerHandler,
	options: { method?: string; body?: unknown; query?: string; cookie?: string | null } = {}
) {
	const handler = factory({ ctx: () => h, config, bus: h.bus });
	const cookie = options.cookie === undefined ? signSession(SESSION_SECRET) : options.cookie;
	const url = `http://dash.test/api/notifications${options.query ?? ''}`;

	const response = await handler({
		request: new Request(url, {
			method: options.method ?? 'GET',
			...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
		}),
		params: {},
		cookies: { get: (name: string) => (name === SESSION_COOKIE && cookie ? cookie : undefined) }
	});

	return { status: response.status, body: (await response.json()) as Record<string, never> };
}

type Row = { id: string; path: string; kind: string; seenAt: number | null };

describe('GET /api/notifications', () => {
	it('lists what happened, newest first, with somewhere to click', async () => {
		const first = postUpdate(h, { project: slug, agentId, body: 'one' });
		const second = postUpdate(h, { project: slug, agentId, body: 'two' });

		const { status, body } = await call(listNotificationsHandler);

		expect(status).toBe(200);
		const rows = body.notifications as unknown as Row[];
		expect(rows.map((row) => row.path)).toEqual([
			`/projects/${slug}?focus=${second.id}`,
			`/projects/${slug}?focus=${first.id}`
		]);
		expect(body.unseen).toBe(2);
	});

	it('can hand back only what is unread', async () => {
		postUpdate(h, { project: slug, agentId, body: 'one' });
		const all = (await call(listNotificationsHandler)).body.notifications as unknown as Row[];
		await call(markNotificationsSeenHandler, { method: 'POST', body: { ids: [all[0]!.id] } });

		const { body } = await call(listNotificationsHandler, { query: '?unseen=true' });

		expect(body.notifications).toEqual([]);
		expect(body.unseen).toBe(0);
	});

	it('refuses a caller with no session', async () => {
		const { status } = await call(listNotificationsHandler, { cookie: null });

		expect(status).toBe(401);
	});
});

describe('POST /api/notifications/seen', () => {
	it('clears one without clearing the rest', async () => {
		postUpdate(h, { project: slug, agentId, body: 'one' });
		postUpdate(h, { project: slug, agentId, body: 'two' });
		const rows = (await call(listNotificationsHandler)).body.notifications as unknown as Row[];

		const { body } = await call(markNotificationsSeenHandler, {
			method: 'POST',
			body: { ids: [rows[0]!.id] }
		});

		expect(body).toMatchObject({ changed: 1, unseen: 1 });
	});

	it('clears everything when told nothing in particular', async () => {
		postUpdate(h, { project: slug, agentId, body: 'one' });
		postUpdate(h, { project: slug, agentId, body: 'two' });

		const { body } = await call(markNotificationsSeenHandler, { method: 'POST' });

		expect(body).toMatchObject({ changed: 2, unseen: 0 });
	});

	it('refuses a caller with no session', async () => {
		postUpdate(h, { project: slug, agentId, body: 'one' });

		const { status } = await call(markNotificationsSeenHandler, {
			method: 'POST',
			cookie: null
		});

		expect(status).toBe(401);
	});
});
