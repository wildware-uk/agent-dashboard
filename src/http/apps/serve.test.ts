import { harness, type Harness } from '$domain/testing';
import { attachApps, checkedApps, createProject, postUpdate, registerApp } from '$domain';
import { beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE, signSession } from '../auth';
import { createAppHandler, policyFor } from './serve';

/**
 * `GET /apps/:view` (migration 041).
 *
 * The only route here that answers with HTML somebody else wrote, so what is
 * checked is the containment: who may read it, what policy it carries, and that
 * an address nobody was handed answers with nothing.
 */
const SESSION_SECRET = 's'.repeat(32);
const authConfig = () => ({ sessionSecret: SESSION_SECRET, adminPasswordHash: '$argon2id$x' });

const HTML = '<!doctype html><title>Board</title><p id="root">3 to review';

let ctx: Harness;
let agentId: string;
let viewId: string;

beforeEach(() => {
	ctx = harness();
	agentId = ctx.agent('scout');
	const slug = createProject(ctx, { name: 'Agent Dashboard' }).project.slug;
	const update = postUpdate(ctx, { project: slug, agentId, body: 'shipped' });

	registerApp(ctx, {
		agentId,
		uri: 'ui://review-board',
		name: 'Review board',
		html: HTML,
		csp: { connect: ['https://api.example.com'] }
	});

	const [checked] = checkedApps(ctx, [{ app: 'ui://review-board', data: { open: 3 } }]);
	viewId = attachApps(ctx, {
		apps: [checked],
		card: { kind: 'update', id: update.id },
		agentId,
		author: `agent:${agentId}`
	})[0].id;
});

function get(id: string, options: { cookie?: string | undefined } = {}) {
	const handler = createAppHandler({ context: () => ctx, config: authConfig });
	const cookie = 'cookie' in options ? options.cookie : signSession(SESSION_SECRET);

	return handler({
		params: { view: id },
		cookies: { get: (name: string) => (name === SESSION_COOKIE ? cookie : undefined) }
	});
}

describe('serving an app', () => {
	it('answers with the document, as the spec’s mime', async () => {
		const response = await get(viewId);

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('text/html;profile=mcp-app;charset=utf-8');
		expect(await response.text()).toBe(HTML);
	});

	it('refuses a caller with no session', async () => {
		const response = await get(viewId, { cookie: undefined });

		expect(response.status).toBe(401);
		expect(await response.text()).toContain('unauthenticated');
	});

	it('answers nothing for a showing that does not exist', async () => {
		expect((await get('nothing')).status).toBe(404);
		expect((await get('')).status).toBe(404);
	});

	it('is never cached and never sniffed', async () => {
		const response = await get(viewId);

		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(response.headers.get('x-content-type-options')).toBe('nosniff');
		expect(response.headers.get('referrer-policy')).toBe('no-referrer');
	});

	it('carries a policy built from what the app declared', async () => {
		const policy = (await get(viewId)).headers.get('content-security-policy') ?? '';

		expect(policy).toContain(`default-src 'none'`);
		expect(policy).toContain('connect-src https://api.example.com');
		// This document is for this dashboard's pages, and nobody else's.
		expect(policy).toContain(`frame-ancestors 'self'`);
	});
});

describe('the policy', () => {
	it('reaches nothing at all when an app declared nothing', () => {
		const policy = policyFor({ connect: [], resource: [], frame: [] });

		expect(policy).toContain(`default-src 'none'`);
		expect(policy).toContain(`connect-src 'none'`);
		expect(policy).toContain(`frame-src 'none'`);
		expect(policy).toContain(`form-action 'none'`);
		expect(policy).toContain(`base-uri 'none'`);
	});

	it('never allows a script to be fetched, only the one in the document', () => {
		const policy = policyFor({ connect: [], resource: ['https://cdn.example.com'], frame: [] });

		expect(policy).toContain(`script-src 'unsafe-inline'`);
		expect(policy).not.toContain('script-src https://cdn.example.com');
		expect(policy).toContain('img-src data: blob: https://cdn.example.com');
	});
});
