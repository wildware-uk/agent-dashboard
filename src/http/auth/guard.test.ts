import { describe, expect, it } from 'vitest';
import { LOGIN_PATH, loginRedirect, requiresSession, safeRedirectTarget } from './guard';

describe('what the session guard covers', () => {
	it('guards every browser route', () => {
		for (const pathname of ['/', '/projects', '/projects/acme', '/settings']) {
			expect(requiresSession(pathname), pathname).toBe(true);
		}
	});

	it('guards the browser API routes', () => {
		for (const pathname of ['/api/stream', '/api/projects', '/api/approvals/01H/decide']) {
			expect(requiresSession(pathname), pathname).toBe(true);
		}
	});

	it('leaves /mcp alone: it authenticates with a bearer token (design §5)', () => {
		for (const pathname of ['/mcp', '/mcp/', '/mcp/messages']) {
			expect(requiresSession(pathname), pathname).toBe(false);
		}
	});

	it('still guards a browser route that merely starts with the same letters as /mcp', () => {
		expect(requiresSession('/mcp-docs')).toBe(true);
		expect(requiresSession('/mcpx')).toBe(true);
	});

	it('leaves the agent upload route alone: it carries its own single-use token (design §6)', () => {
		expect(requiresSession('/api/upload/abc.def')).toBe(false);
	});

	it('does not guard login or logout, or the owner could never reach them', () => {
		expect(requiresSession('/login')).toBe(false);
		expect(requiresSession('/logout')).toBe(false);
	});

	it('ignores a trailing slash rather than opening a hole', () => {
		expect(requiresSession('/projects/')).toBe(true);
		expect(requiresSession('/login/')).toBe(false);
	});
});

describe('where an unauthenticated visitor is sent', () => {
	it('remembers where they were going', () => {
		const target = loginRedirect(new URL('http://x/projects/acme?tab=tasks'));

		expect(target).toBe(`${LOGIN_PATH}?redirectTo=%2Fprojects%2Facme%3Ftab%3Dtasks`);
	});

	it('does not bother remembering the root', () => {
		expect(loginRedirect(new URL('http://x/'))).toBe(LOGIN_PATH);
	});

	it('never sends them back to a route that would sign them out again', () => {
		expect(loginRedirect(new URL('http://x/logout'))).toBe(LOGIN_PATH);
	});
});

describe('the post-login destination', () => {
	it('keeps a same-site path, query and fragment intact', () => {
		expect(safeRedirectTarget('/projects/acme?tab=tasks#top')).toBe('/projects/acme?tab=tasks#top');
	});

	it('falls back to the root for anything that could leave the site', () => {
		for (const raw of [
			null,
			undefined,
			'',
			'//evil.example.com/phish',
			'/\\evil.example.com',
			'http://evil.example.com',
			'https://evil.example.com',
			'javascript:alert(1)',
			'not-a-path',
			'/logout',
			// `new URL()` strips control characters, so the same-site checks below
			// never see them. A surviving CR/LF reaches `redirect()`, which refuses
			// to put it in a Location header and throws — turning a *correct*
			// password into a 500 instead of a trip to the dashboard.
			'/foo\nX-Injected: 1',
			'/foo\r\nX-Injected: 1',
			'/foo\u0000',
			'/foo\u007f'
		]) {
			expect(safeRedirectTarget(raw), String(raw)).toBe('/');
		}
	});
});
