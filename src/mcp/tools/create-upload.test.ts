import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mcpHarness, toolText, type McpHarness } from '../testing';
import { createUploadTool } from './create-upload';

let mcp: McpHarness;
let dataDir: string;

/**
 * A configured deployment.
 *
 * `create_upload` reads `PUBLIC_BASE_URL`, `TOKEN_SECRET` and the caps through
 * `$config`, because a tool may not import `$media` to be handed settings
 * (design §2). So the environment is what a test sets — which is also the only
 * way to prove the URL an agent receives comes from `PUBLIC_BASE_URL` and not
 * from wherever the server happens to be listening.
 */
beforeEach(() => {
	mcp = mcpHarness({ name: 'scout' });
	dataDir = mkdtempSync(join(tmpdir(), 'agent-dashboard-tool-'));
	vi.stubEnv('DATA_DIR', dataDir);
	vi.stubEnv('TOKEN_SECRET', 't'.repeat(40));
	vi.stubEnv('SESSION_SECRET', 's'.repeat(40));
	vi.stubEnv('ADMIN_PASSWORD_HASH', '$argon2id$v=19$m=65536,t=3,p=4$salt$hash');
	vi.stubEnv('PUBLIC_BASE_URL', 'https://agents.wildware.dev');
	vi.stubEnv('MAX_IMAGE_BYTES', '4096');
	vi.stubEnv('MAX_VIDEO_BYTES', '8192');
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(dataDir, { recursive: true, force: true });
});

const run = (args: Parameters<typeof createUploadTool.run>[1]) =>
	createUploadTool.run(mcp.deps, args);

const png = { filename: 'shot.png', mime: 'image/png', bytes: 1024 };

describe('create_upload', () => {
	it('hands back an absolute upload URL built from PUBLIC_BASE_URL', () => {
		const result = run(png);
		const data = result.structuredContent as Record<string, string>;

		expect(result.isError).toBeUndefined();
		expect(data.upload_url.startsWith('https://agents.wildware.dev/api/upload/')).toBe(true);
		expect(data.upload_url).not.toContain('127.0.0.1');
		expect(data.upload_url).not.toContain('localhost');
		expect(data.media_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
		expect(data.max_bytes).toBe(1024);
	});

	it('says when the URL expires, as a timestamp an agent can read', () => {
		const data = run(png).structuredContent as Record<string, string>;

		// Fifteen minutes from the harness clock (design §6).
		expect(data.expires_at).toBe(new Date(mcp.h.now() + 15 * 60 * 1000).toISOString());
	});

	it('tells the agent what to do next, in the summary line', () => {
		const text = toolText(run(png));

		expect(text).toContain('PUT the raw bytes');
		expect(text).toContain('post_update');
	});

	it('publishes nothing: a reservation is not news', () => {
		run(png);

		expect(mcp.h.eventNames()).toEqual([]);
	});

	it('refuses SVG, and says so as an argument error the agent can act on', () => {
		const result = run({ filename: 'diagram.svg', mime: 'image/svg+xml', bytes: 100 });

		expect(result.isError).toBe(true);
		expect(result.structuredContent).toMatchObject({ error: 'invalid_argument' });
		expect(toolText(result)).toContain('SVG');
	});

	it('refuses a type off the allowlist, naming what is allowed', () => {
		const result = run({ filename: 'notes.pdf', mime: 'application/pdf', bytes: 100 });

		expect(result.isError).toBe(true);
		expect(toolText(result)).toContain('image/png');
	});

	it('refuses a file over this deployment`s cap for its kind', () => {
		expect(run({ ...png, bytes: 4097 }).isError).toBe(true);
		// The video cap is its own, so a video that size is fine.
		expect(run({ filename: 'clip.mp4', mime: 'video/mp4', bytes: 4097 }).isError).toBeUndefined();
	});

	it('reserves the media against the calling agent, from the token and nothing else', () => {
		const data = run(png).structuredContent as Record<string, string>;
		const media = mcp.h.db
			.prepare('SELECT agent_id AS agentId, status FROM media WHERE id = ?')
			.get(data.media_id) as { agentId: string; status: string };

		expect(media.agentId).toBe(mcp.deps.agent.id);
		expect(media.status).toBe('pending');
	});

	it('fails as an internal error, not a crash, when the deployment is misconfigured', () => {
		vi.stubEnv('TOKEN_SECRET', '');

		const result = run(png);

		expect(result.isError).toBe(true);
		expect(result.structuredContent).toMatchObject({ error: 'internal_error' });
	});
});
