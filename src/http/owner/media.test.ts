import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harness, type Harness } from '$domain/testing';
import { pngBytes } from '$media/testing';
import { SESSION_COOKIE, signSession } from '../auth';
import { uploadMediaHandler } from './media';
import type { OwnerHandler } from './actions';

/**
 * `POST /api/media` — the owner's own upload (migration 016).
 *
 * The counterpart to `create_upload`, and a different shape on purpose: an
 * agent is remote and needs a token to authorise a request with no session; the
 * owner's browser puts the bytes on a request that already carries the cookie.
 * What must not differ is anything after that — same allowlist, same caps, same
 * sniffing — so the refusals below are the ones an agent would get too.
 */
const SESSION_SECRET = 's'.repeat(32);
const config = () => ({ sessionSecret: SESSION_SECRET, adminPasswordHash: '$argon2id$x' });

/** A real PNG, so the sniffer sees what the header claims. */
const PNG = new Uint8Array(pngBytes()).slice().buffer as ArrayBuffer;

let h: Harness;
let dataDir: string;

beforeEach(() => {
	h = harness();
	// The pipeline writes files, so a throwaway directory: a test must never
	// write into a real DATA_DIR.
	dataDir = mkdtempSync(join(tmpdir(), 'agent-dashboard-owner-media-'));
	vi.stubEnv('DATA_DIR', dataDir);
	vi.stubEnv('PUBLIC_BASE_URL', 'https://agents.example.test');
	// `mediaSettings()` reads the whole config, so the boot-time requirements have
	// to be satisfied even though nothing here signs or verifies anything.
	vi.stubEnv('SESSION_SECRET', SESSION_SECRET);
	vi.stubEnv('TOKEN_SECRET', 't'.repeat(40));
	vi.stubEnv('ADMIN_PASSWORD_HASH', '$argon2id$v=19$m=65536,t=3,p=4$salt$hash');
});

afterEach(() => {
	rmSync(dataDir, { recursive: true, force: true });
});

async function upload(
	body: BodyInit | null,
	options: { mime?: string; filename?: string; cookie?: string | null } = {}
) {
	const handler: OwnerHandler = uploadMediaHandler({ ctx: () => h, config });
	const cookie = options.cookie === undefined ? signSession(SESSION_SECRET) : options.cookie;
	const url = new URL('http://dash.test/api/media');
	if (options.filename) url.searchParams.set('filename', options.filename);

	const response = await handler({
		request: new Request(url, {
			method: 'POST',
			headers: options.mime === undefined ? {} : { 'content-type': options.mime },
			body,
			// Node requires this for a streamed body.
			duplex: 'half'
		} as RequestInit),
		params: {},
		cookies: { get: (name: string) => (name === SESSION_COOKIE && cookie ? cookie : undefined) }
	});

	return { status: response.status, body: (await response.json()) as Record<string, never> };
}

describe('the owner uploading an image', () => {
	it('takes the bytes and answers with the row, attributed to the owner', async () => {
		const { status, body } = await upload(PNG, { mime: 'image/png', filename: 'shot.png' });

		expect(status).toBe(201);
		expect(body.media).toMatchObject({ author: 'human', agentId: null, kind: 'image' });
	});

	it('hands back a row attached to nothing, for the message to claim', async () => {
		const { body } = await upload(PNG, { mime: 'image/png' });

		expect(body.media).toMatchObject({ updateId: null, messageId: null });
	});

	it('refuses a declared type that is not a type, exactly as an agent is refused', async () => {
		const { status } = await upload(PNG, { mime: 'image/*', filename: 'x.svg' });

		expect(status).toBe(400);
	});

	it('takes a file that is not a picture, and keeps the name it came with', async () => {
		// The owner asked to be able to send agents any file (migration 026). An
		// SVG is the sharp case: never rendered, perfectly storable as a download.
		const { status, body } = await upload(new TextEncoder().encode('<svg />'), {
			mime: 'image/svg+xml',
			filename: 'diagram.svg'
		});

		expect(status).toBe(201);
		expect(body.media).toMatchObject({ kind: 'file', mime: 'image/svg+xml' });
	});

	it('refuses a request with no body rather than storing an empty row', async () => {
		const { status } = await upload(null, { mime: 'image/png' });

		expect(status).toBe(400);
	});

	it('refuses a caller with no session: this is not a public upload', async () => {
		const { status } = await upload(PNG, { mime: 'image/png', cookie: null });

		expect(status).toBe(401);
	});
});
