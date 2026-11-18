import { harness, type Harness } from '$domain/testing';
import { createProject, mintAgentToken, postMessage } from '$domain';
import { createOwnerMedia, storeBytes } from '$media';
import { bodyOf, pngBytes, tempSettings } from '$media/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAgentMediaHandler } from './agent';

/**
 * `GET /api/agent/media/:id` (the owner's "the agent cannot see my glb").
 *
 * What is checked here is the boundary: an agent's own token is enough for an
 * attachment that was sent to it, and is not enough for anything else.
 */
const TOKEN_SECRET = 't'.repeat(40);
const mcpConfig = () => ({ tokenSecret: TOKEN_SECRET, holdMs: 1000 });

let ctx: Harness;
let temp: ReturnType<typeof tempSettings>;
let settings: ReturnType<typeof tempSettings>['settings'];
let token: string;

beforeEach(() => {
	ctx = harness();
	temp = tempSettings();
	settings = temp.settings;
	token = mintAgentToken(ctx, { name: 'scout', secret: TOKEN_SECRET }).token;
	createProject(ctx, { name: 'Agent Dashboard' });
});

afterEach(() => temp.cleanup());

/** An upload that really landed, by the route the owner's own attachments take. */
async function uploaded(bytes = pngBytes(), mime = 'image/png', filename = 'shot.png') {
	const created = createOwnerMedia(settings, {
		db: ctx.db,
		filename,
		mime,
		bytes: bytes.length,
		now: ctx.now()
	});
	await storeBytes(settings, {
		db: ctx.db,
		media: created.media,
		body: bodyOf(bytes),
		maxBytes: created.maxBytes,
		allowed: created.allowed
	});
	return created.media.id;
}

/** The same upload, put on a message the way a reply with a file is. */
async function attached(): Promise<string> {
	const id = await uploaded();
	// Posted the way the owner's own reply posts it: the media rides with the
	// message, which is what makes it an attachment rather than an upload.
	postMessage(ctx, {
		project: 'agent-dashboard',
		body: 'have a look',
		author: { kind: 'human' },
		mediaIds: [id]
	});
	return id;
}

function get(id: string, bearer: string | null = token) {
	const handler = createAgentMediaHandler({
		context: () => ctx,
		settings: () => settings,
		config: mcpConfig as never
	});

	return handler({
		request: new Request(`https://dash.test/api/agent/media/${id}`, {
			headers: bearer === null ? {} : { authorization: `Bearer ${bearer}` }
		}),
		params: { id, variant: 'original' },
		cookies: { get: () => undefined }
	});
}

describe('an agent fetching what it was sent', () => {
	it('hands over the bytes to a valid token', async () => {
		const id = await attached();

		const response = await get(id);

		expect(response.status).toBe(200);
		expect((await response.arrayBuffer()).byteLength).toBe(pngBytes().length);
	});

	it('refuses a caller with no token, and one with a token that is not a token', async () => {
		const id = await attached();

		expect((await get(id, null)).status).toBe(404);
		expect((await get(id, 'not-a-real-token')).status).toBe(404);
	});

	it('will not hand over an upload that is attached to nothing', async () => {
		// Somebody mid-post. Nobody has been sent it, so nobody may fetch it.
		const id = await uploaded();

		expect((await get(id)).status).toBe(404);
	});

	it('answers 404 for an id that does not exist', async () => {
		expect((await get('01K3ABCDEFGHJKMNPQRSTVWXYZ')).status).toBe(404);
		expect((await get('../../etc/passwd')).status).toBe(404);
	});
});
