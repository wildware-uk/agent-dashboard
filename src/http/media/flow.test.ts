import { harness, type Harness } from '$domain/testing';
import { attachMediaTool, createUploadTool, postUpdateTool, type ToolDeps } from '$mcp';
import { createProject, mintAgentToken } from '$domain';
import { pngBytes, zipBytes } from '$media/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE, signSession } from '../auth';
import { createMediaHandler } from './serve';
import { createUploadHandler } from './upload';

/**
 * The whole journey, with nothing stubbed but the environment and the clock.
 *
 * `create_upload` over MCP, a real PUT through the upload route, `post_update`
 * carrying the media id, and finally `GET /media/:id/original` — every layer of
 * this slice in the order an agent uses them. The unit tests each prove one rule;
 * this proves the rules compose, which is the failure a slice like this actually
 * ships with.
 *
 * Settings come from the environment here rather than being injected, so the
 * upload URL an agent receives is the one a configured deployment would really
 * hand out.
 */
const SESSION_SECRET = 's'.repeat(40);

let ctx: Harness;
let dataDir: string;
/** What a tool is called with: this request's context and the token holder. */
let deps: ToolDeps;

beforeEach(() => {
	ctx = harness();
	dataDir = mkdtempSync(join(tmpdir(), 'agent-dashboard-flow-'));
	vi.stubEnv('DATA_DIR', dataDir);
	vi.stubEnv('TOKEN_SECRET', 't'.repeat(40));
	vi.stubEnv('SESSION_SECRET', SESSION_SECRET);
	vi.stubEnv('ADMIN_PASSWORD_HASH', '$argon2id$v=19$m=65536,t=3,p=4$salt$hash');
	vi.stubEnv('PUBLIC_BASE_URL', 'https://agents.wildware.dev');
	deps = { ctx, agent: mintAgentToken(ctx, { name: 'scout', secret: 't'.repeat(40) }).agent };
	createProject(ctx, { name: 'Agent Dashboard' });
	ctx.events.length = 0;
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(dataDir, { recursive: true, force: true });
});

/** `create_upload`, as an agent calls it. */
function reserve(bytes: number, mime = 'image/png') {
	const result = createUploadTool.run(deps, { filename: 'shot.png', mime, bytes });
	expect(result.isError, JSON.stringify(result.structuredContent)).toBeUndefined();
	return result.structuredContent as { media_id: string; upload_url: string; max_bytes: number };
}

/** The PUT, driven through the real route handler at the URL the tool handed out. */
async function put(uploadUrl: string, body: Uint8Array) {
	const handler = createUploadHandler({ context: () => ctx });
	const url = new URL(uploadUrl);
	const token = url.pathname.split('/').at(-1)!;

	return handler({
		request: new Request(url, { method: 'PUT', body: new Uint8Array(body) as BodyInit }),
		params: { token }
	});
}

function fetchMedia(id: string, variant = 'original') {
	const handler = createMediaHandler({
		context: () => ctx,
		config: () => ({ sessionSecret: SESSION_SECRET, adminPasswordHash: '$argon2id$x' })
	});

	return handler({
		request: new Request(`https://agents.wildware.dev/media/${id}/${variant}`),
		params: { id, variant },
		cookies: {
			get: (name: string) => (name === SESSION_COOKIE ? signSession(SESSION_SECRET) : undefined)
		}
	});
}

describe('the whole upload journey', () => {
	it('reserves, uploads, posts and serves', async () => {
		const png = pngBytes();
		const reserved = reserve(png.length);

		expect(reserved.upload_url.startsWith('https://agents.wildware.dev/api/upload/')).toBe(true);

		const uploaded = await put(reserved.upload_url, png);
		expect(uploaded.status).toBe(201);

		const posted = postUpdateTool.run(deps, {
			project: 'agent-dashboard',
			body: 'Login is fixed, see the screenshot.',
			media_ids: [reserved.media_id]
		});
		expect(posted.isError).toBeUndefined();

		// One event for the whole journey, and it is the update — the upload said
		// nothing, because there is nothing for a browser to draw until the
		// derivative pipeline (#8) announces `media.ready`.
		expect(ctx.eventNames()).toEqual(['update.created']);

		const served = await fetchMedia(reserved.media_id);
		expect(served.status).toBe(200);
		expect(served.headers.get('content-type')).toBe('image/png');
		expect(served.headers.get('x-content-type-options')).toBe('nosniff');
		expect(new Uint8Array(await served.arrayBuffer())).toEqual(png);
	});

	it('lets media land after the update, which is what attach_media is for', async () => {
		const png = pngBytes();
		const reserved = reserve(png.length);

		const posted = postUpdateTool.run(deps, {
			project: 'agent-dashboard',
			body: 'Recording the repro now.'
		});
		const updateId = (posted.structuredContent as { update: { id: string } }).update.id;

		await put(reserved.upload_url, png);
		const attached = attachMediaTool.run(deps, {
			update_id: updateId,
			media_ids: [reserved.media_id]
		});

		expect(attached.structuredContent).toMatchObject({ attached: [reserved.media_id] });
		expect((await fetchMedia(reserved.media_id)).status).toBe(200);
	});

	it('serves nothing for an upload that was refused', async () => {
		const zip = zipBytes();
		const reserved = reserve(zip.length);

		const refused = await put(reserved.upload_url, zip);

		expect(refused.status).toBe(415);
		expect((await fetchMedia(reserved.media_id)).status).toBe(404);

		// And the id cannot be smuggled onto an update either: nothing landed under
		// it, so `post_update` refuses the whole post.
		const posted = postUpdateTool.run(deps, {
			project: 'agent-dashboard',
			body: 'trying it on',
			media_ids: [reserved.media_id]
		});

		expect(posted.isError).toBe(true);
		expect(ctx.eventNames()).toEqual([]);
	});
});
