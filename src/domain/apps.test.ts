import { beforeEach, describe, expect, it } from 'vitest';
import { harness, type Harness } from './testing';
import { isDomainError } from './errors';
import { createProject } from './projects';
import { postUpdate } from './updates';
import {
	APPS_PER_POST_MAX,
	APP_HTML_MAX_LENGTH,
	appDocument,
	appsOn,
	attachApps,
	checkedApps,
	listAppSummaries,
	parseAppCsp,
	parseAppUri,
	registerApp,
	saveAppState,
	setAppData
} from './apps';
import type { CardRef } from '$db';

/**
 * Apps: interactive UI an agent supplies (migration 041).
 *
 * The owner: "I want apps to be able to embed UI directly into the dashboard."
 * What is checked here is the half the sandbox cannot do for us — that a handle
 * is a `ui://` URI, that a declared origin is an origin, and that the two
 * directions of state stay out of each other's way.
 */
let h: Harness;
let agentId: string;
let other: string;
let slug: string;
let card: CardRef;

const HTML = '<!doctype html><title>Board</title><div id="root"></div>';

function codeOf(run: () => unknown): string {
	try {
		run();
	} catch (error) {
		if (isDomainError(error)) return error.code;
		throw error;
	}
	throw new Error('expected a refusal');
}

function register(overrides: Record<string, unknown> = {}) {
	return registerApp(h, {
		agentId,
		uri: 'ui://review-board',
		name: 'Review board',
		html: HTML,
		...overrides
	});
}

function put(uri = 'ui://review-board', data: Record<string, unknown> = { open: 3 }) {
	const [checked] = checkedApps(h, [{ app: uri, data }]);
	return attachApps(h, { apps: [checked], card, agentId, author: `agent:${agentId}` })[0];
}

beforeEach(() => {
	h = harness();
	agentId = h.agent('scout');
	other = h.agent('rover');
	slug = createProject(h, { name: 'Agent Dashboard' }).project.slug;
	card = { kind: 'update', id: postUpdate(h, { project: slug, agentId, body: 'shipped' }).id };
});

describe('registering an app', () => {
	it('keeps the ui:// handle and reports what it stored', () => {
		const app = register({ description: 'Everything waiting on review' });

		expect(app).toMatchObject({
			uri: 'ui://review-board',
			name: 'Review board',
			description: 'Everything waiting on review',
			mine: true
		});
		expect(app.bytes).toBe(Buffer.byteLength(HTML, 'utf8'));
	});

	it('replaces its own app rather than making a second one', () => {
		register();
		register({ name: 'Review board v2', html: '<!doctype html><p>newer' });

		const apps = listAppSummaries(h, agentId);
		expect(apps).toHaveLength(1);
		expect(apps[0].name).toBe('Review board v2');
	});

	it('will not let one agent overwrite another agent’s app', () => {
		register();
		expect(
			codeOf(() =>
				registerApp(h, { agentId: other, uri: 'ui://review-board', name: 'Mine', html: HTML })
			)
		).toBe('conflict');
	});

	it('refuses a handle that is not a ui:// URI', () => {
		expect(codeOf(() => register({ uri: 'https://example.com/board' }))).toBe('invalid_argument');
		expect(codeOf(() => register({ uri: 'ui://Review Board' }))).toBe('invalid_argument');
		expect(parseAppUri('  UI://Acme/Review-Board ', 'uri')).toBe('ui://acme/review-board');
	});

	it('refuses an empty document and one past the size cap', () => {
		expect(codeOf(() => register({ html: '   ' }))).toBe('invalid_argument');
		expect(codeOf(() => register({ html: 'x'.repeat(APP_HTML_MAX_LENGTH + 1) }))).toBe(
			'invalid_argument'
		);
	});
});

describe('an app that lives somewhere else (migration 042)', () => {
	it('frames the service’s own page, and serves no document for it', () => {
		const app = register({ html: undefined, url: 'https://fix.example.com/embed?q=open' });

		expect(app.url).toBe('https://fix.example.com/embed?q=open');
		expect(app.bytes).toBe(0);

		const view = put();
		// Nothing to serve: the card points the frame at the service instead.
		expect(appDocument(h, view.id)).toBeUndefined();
		expect(appsOn(h, card)[0].url).toBe('https://fix.example.com/embed?q=open');
	});

	it('insists on one of the two, and refuses both', () => {
		expect(codeOf(() => register({ html: undefined }))).toBe('invalid_argument');
		expect(codeOf(() => register({ url: 'https://fix.example.com/embed' }))).toBe(
			'invalid_argument'
		);
	});

	it('refuses a page that is not https, or one carrying credentials', () => {
		for (const url of [
			'http://fix.example.com/embed',
			'javascript:alert(1)',
			'https://user:pass@fix.example.com/embed',
			'not a url'
		]) {
			expect(
				codeOf(() => register({ html: undefined, url })),
				url
			).toBe('invalid_argument');
		}
	});
});

describe('the origins an app declares', () => {
	it('keeps plain https origins and drops nothing else', () => {
		const app = register({
			csp: { connect: ['https://api.example.com'], resource: [], frame: [] }
		});
		expect(app.csp.connect).toEqual(['https://api.example.com']);
	});

	it('refuses http, a path, a wildcard and credentials', () => {
		for (const origin of [
			'http://api.example.com',
			'https://api.example.com/v1',
			'*',
			'https://user:pass@api.example.com',
			'data:'
		]) {
			expect(
				codeOf(() => parseAppCsp({ connect: [origin] }, 'csp')),
				origin
			).toBe('invalid_argument');
		}
	});

	it('is empty when an app declares nothing, so it reaches nothing', () => {
		expect(register().csp).toEqual({ connect: [], resource: [], frame: [] });
	});
});

describe('showing one on a card', () => {
	it('carries the data the agent handed it, and the app it is drawn in', () => {
		register();
		put();

		const [view] = appsOn(h, card);
		expect(view).toMatchObject({ uri: 'ui://review-board', name: 'Review board' });
		expect(view.data).toEqual({ open: 3 });
		expect(view.state).toBeNull();
	});

	it('refuses a post naming an app nobody registered, before anything is written', () => {
		expect(codeOf(() => checkedApps(h, [{ app: 'ui://nope' }]))).toBe('invalid_argument');
	});

	it('refuses more apps than a card can carry', () => {
		register();
		const many = Array.from({ length: APPS_PER_POST_MAX + 1 }, () => ({
			app: 'ui://review-board'
		}));
		expect(codeOf(() => checkedApps(h, many))).toBe('invalid_argument');
	});

	it('serves the document and the policy the app declared', () => {
		register({ csp: { resource: ['https://cdn.example.com'] } });
		const view = put();

		expect(appDocument(h, view.id)).toEqual({
			html: HTML,
			csp: { connect: [], resource: ['https://cdn.example.com'], frame: [] }
		});
	});
});

describe('the two directions of state', () => {
	it('pushes fresh data into a showing and announces it', () => {
		register();
		const view = put();
		const events: string[] = [];
		h.bus.subscribe((event) => events.push(event.type));

		const updated = setAppData(h, { viewId: view.id, data: { open: 1 }, title: 'One left' });

		expect(updated.data).toEqual({ open: 1 });
		expect(updated.title).toBe('One left');
		expect(events).toContain('apps.changed');
	});

	it('leaves what the app saved alone when the agent sends new data', () => {
		register();
		const view = put();
		saveAppState(h, view.id, { tab: 'diff' });

		const updated = setAppData(h, { viewId: view.id, data: { open: 0 } });

		expect(updated.state).toEqual({ tab: 'diff' });
		expect(updated.data).toEqual({ open: 0 });
	});

	it('does not redraw every tab because the app opened a section', () => {
		register();
		const view = put();
		const events: string[] = [];
		h.bus.subscribe((event) => events.push(event.type));

		saveAppState(h, view.id, { tab: 'diff' });

		expect(events).not.toContain('apps.changed');
	});

	it('refuses data that is not a JSON object', () => {
		register();
		const view = put();
		expect(codeOf(() => setAppData(h, { viewId: view.id, data: ['nope'] }))).toBe(
			'invalid_argument'
		);
	});

	it('refuses a showing that does not exist', () => {
		expect(codeOf(() => setAppData(h, { viewId: 'nothing', data: {} }))).toBe('not_found');
	});
});
