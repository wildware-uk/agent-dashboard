import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProject, postMessage, uploadOwnerMedia } from '$domain';
import { bodyOf, pngBytes, tempSettings } from '$media/testing';
import { mcpHarness, toolText, type McpHarness } from './testing';
import { getMessagesTool } from './tools';
import { MAX_INLINE_FILE_BYTES, MAX_INLINE_IMAGES, downloadUrl } from './attachments';

/**
 * Images reaching the agent that was asked about them.
 *
 * The owner's report, in their words: "Agents can not see attached images — the
 * dashboard gives me the message text and not its attachments." They are right,
 * and the reason is structural: `/media/:id/:variant` wants the owner's session
 * (design §8), so an agent cannot fetch a picture however many ids it is given.
 * The bytes have to ride back inside the tool result, which is what these
 * assert.
 */

let mcp: McpHarness;
let temp: ReturnType<typeof tempSettings>;
let slug: string;

beforeEach(() => {
	mcp = mcpHarness();
	temp = tempSettings();
	mcp.deps.media = temp.settings;
	slug = createProject(mcp.h, { name: 'Agent Dashboard' }).project.slug;
});

afterEach(() => temp.cleanup());

/** An image the owner uploaded, with its bytes actually on disk. */
async function anImage(): Promise<string> {
	return await anUpload(pngBytes(), 'image/png', 'shot.png');
}

/** Anything the owner uploaded, with its bytes actually on disk. */
async function anUpload(bytes: Uint8Array, mime: string, filename: string): Promise<string> {
	const media = await uploadOwnerMedia(
		mcp.h,
		{ filename, mime, body: bodyOf(bytes), contentLength: bytes.length },
		temp.settings
	);
	return media.id;
}

/** The owner says something with pictures on it. */
async function fromOwnerWith(count: number, body = 'what is wrong with this?') {
	const mediaIds: string[] = [];
	for (let index = 0; index < count; index += 1) mediaIds.push(await anImage());
	return postMessage(mcp.h, { author: { kind: 'human' }, project: slug, body, mediaIds });
}

const imagesIn = (result: Awaited<ReturnType<typeof getMessagesTool.run>>) =>
	result.content.filter((block) => block.type === 'image');

describe('reading a message with an image on it', () => {
	it('hands the agent the picture, not only the words', async () => {
		await fromOwnerWith(1);

		const result = await getMessagesTool.run(mcp.deps, {});

		const images = imagesIn(result);
		expect(images).toHaveLength(1);
		expect(images[0]).toMatchObject({ type: 'image', mimeType: expect.stringContaining('image/') });
		expect((images[0] as { data: string }).data.length).toBeGreaterThan(0);
	});

	it('says in words that the image is there, so it is not missed', async () => {
		const message = await fromOwnerWith(1);

		const said = toolText(await getMessagesTool.run(mcp.deps, {}));

		expect(said).toContain('1 attachment is included below');
		expect(said).toContain(message.id);
	});

	it('leaves a plain message exactly as it was', async () => {
		postMessage(mcp.h, { author: { kind: 'human' }, project: slug, body: 'just words' });

		const result = await getMessagesTool.run(mcp.deps, {});

		expect(imagesIn(result)).toEqual([]);
		expect(toolText(result)).toContain('1 new message');
		expect(toolText(result)).not.toContain('attached below');
	});

	it('caps how many pictures one read carries, and says what it left out', async () => {
		await fromOwnerWith(MAX_INLINE_IMAGES + 2);

		const result = await getMessagesTool.run(mcp.deps, {});

		expect(imagesIn(result)).toHaveLength(MAX_INLINE_IMAGES);
		// Named rather than silently dropped: an agent that thinks it has seen
		// everything answers as though it has.
		expect(toolText(result)).toContain('not shown');
	});

	it('still delivers the words when the bytes cannot be read', async () => {
		const message = await fromOwnerWith(1);
		temp.cleanup();

		const result = await getMessagesTool.run(mcp.deps, {});

		expect(result.isError).toBeFalsy();
		expect(imagesIn(result)).toEqual([]);
		expect(toolText(result)).toContain(message.body);
		expect(toolText(result)).toContain('not shown');
	});
});

/**
 * Files reaching the agent they were sent to (migration 026).
 *
 * The owner asked to be able to send agents any file, not just images. A file
 * the agent cannot read is a file that was not sent, so the bytes ride back in
 * the tool result exactly as a picture's do — as text where text is meaningful,
 * which is the case that actually comes up: a log, a diff, a CSV.
 */
describe('reading a message with a file on it', () => {
	const textIn = (result: Awaited<ReturnType<typeof getMessagesTool.run>>) =>
		result.content.filter((block) => block.type === 'text');

	async function fromOwnerWithFile(bytes: Uint8Array, mime: string, filename: string) {
		const mediaId = await anUpload(bytes, mime, filename);
		return postMessage(mcp.h, {
			author: { kind: 'human' },
			project: slug,
			body: 'have a look at this',
			mediaIds: [mediaId]
		});
	}

	it('hands over a text file as text the agent can quote back', async () => {
		await fromOwnerWithFile(
			new TextEncoder().encode('ERROR: boom at line 12\n'),
			'text/plain',
			'build.log'
		);

		const result = await getMessagesTool.run(mcp.deps, {});
		const blocks = textIn(result);

		// The first text block is the tool's own summary and JSON; the file is its
		// own block after it, named so three logs can be told apart.
		expect(blocks.length).toBe(2);
		expect(blocks[1].text).toContain('build.log');
		expect(blocks[1].text).toContain('ERROR: boom at line 12');
	});

	it('hands over a binary file as an embedded resource rather than as mojibake', async () => {
		const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x00, 0xff]);
		await fromOwnerWithFile(bytes, 'application/pdf', 'notes.pdf');

		const result = await getMessagesTool.run(mcp.deps, {});
		const resources = result.content.filter((block) => block.type === 'resource');

		expect(resources.length).toBe(1);
		expect(resources[0].resource).toMatchObject({ mimeType: 'application/pdf' });
		const { resource } = resources[0];
		expect('blob' in resource && Buffer.from(resource.blob, 'base64')).toEqual(Buffer.from(bytes));
	});

	it('names the file in the summary, so nothing is silently missing', async () => {
		await fromOwnerWithFile(new TextEncoder().encode('a,b\n1,2\n'), 'text/csv', 'rows.csv');

		expect(toolText(await getMessagesTool.run(mcp.deps, {}))).toContain('rows.csv');
	});
});

describe('bytes an agent cannot be handed inline', () => {
	it('gives the address to fetch them with, rather than only an apology', () => {
		// The owner: "I sent a glb file, the agent cannot see it." A five-megabyte
		// model is not something to paste into a tool result, but it is still the
		// agent's to have — `/api/agent/media/:id` takes its own bearer token.
		expect(downloadUrl({ baseUrl: 'https://dash.test' } as never, 'm1')).toBe(
			'https://dash.test/api/agent/media/m1'
		);
		// A trailing slash on the configured origin must not double up.
		expect(downloadUrl({ baseUrl: 'https://dash.test/' } as never, 'm1')).toBe(
			'https://dash.test/api/agent/media/m1'
		);
	});

	it('says nothing about fetching when this deployment has no public address', () => {
		expect(downloadUrl(null, 'm1')).toBeNull();
		expect(downloadUrl({ baseUrl: '' } as never, 'm1')).toBeNull();
	});
});

/**
 * The attachment in the structured result, not only in the prose.
 *
 * Reported by another session working for the owner: a 3.4MB `net_gun.glb` was
 * attached to a message, the channel said `attachments="1"`, and the agent found
 * "no blob, no file field and no summary note" — so it told the owner the file
 * had not arrived. The note was there, but only as text in the summary, and
 * nothing in `messages[]` mentioned the attachment at all. A fact that lives
 * only in prose is a fact a client may collapse.
 */
describe('what the structured result says about an attachment', () => {
	const messagesIn = (result: Awaited<ReturnType<typeof getMessagesTool.run>>) =>
		(result.structuredContent as { messages: Record<string, unknown>[] }).messages;

	async function fromOwnerWithFile(bytes: Uint8Array, mime: string, filename: string) {
		const mediaId = await anUpload(bytes, mime, filename);
		return postMessage(mcp.h, {
			author: { kind: 'human' },
			project: slug,
			body: 'have a look at this',
			mediaIds: [mediaId]
		});
	}

	it('names a file that rode along, and says it did', async () => {
		await fromOwnerWithFile(new TextEncoder().encode('a,b\n1,2\n'), 'text/csv', 'rows.csv');

		const [message] = messagesIn(await getMessagesTool.run(mcp.deps, {}));

		expect(message.attachments).toMatchObject([
			{ filename: 'rows.csv', mime: 'text/csv', kind: 'file', included: true }
		]);
	});

	it('names one too big to inline, with the address to fetch it from', async () => {
		// The shape of the owner's model: a binary far past the inline ceiling, so
		// this deployment's own file cap has to be above it.
		const roomy = tempSettings({ maxFileBytes: MAX_INLINE_FILE_BYTES * 2 });
		mcp.deps.media = roomy.settings;

		const big = new Uint8Array(MAX_INLINE_FILE_BYTES + 1);
		big.set(new TextEncoder().encode('glTF'), 0);
		const media = await uploadOwnerMedia(
			mcp.h,
			{
				filename: 'net_gun.glb',
				mime: 'application/octet-stream',
				body: bodyOf(big),
				contentLength: big.length
			},
			roomy.settings
		);
		await postMessage(mcp.h, {
			author: { kind: 'human' },
			project: slug,
			body: 'have a look at this',
			mediaIds: [media.id]
		});

		const [message] = messagesIn(await getMessagesTool.run(mcp.deps, {}));
		roomy.cleanup();
		const [attached] = message.attachments as Record<string, unknown>[];

		expect(attached).toMatchObject({
			filename: 'net_gun.glb',
			kind: 'file',
			bytes: MAX_INLINE_FILE_BYTES + 1,
			included: false
		});
		expect(attached.download_url).toBe(
			`https://agents.example.test/api/agent/media/${attached.media_id}`
		);
		expect(attached.reason).toContain('too large to inline');
	});

	it('says nothing at all on a message with nothing attached', async () => {
		await postMessage(mcp.h, { author: { kind: 'human' }, project: slug, body: 'just words' });

		const [message] = messagesIn(await getMessagesTool.run(mcp.deps, {}));

		expect('attachments' in message).toBe(false);
	});

	it('names an image that rode along as a picture', async () => {
		await fromOwnerWith(1);

		const [message] = messagesIn(await getMessagesTool.run(mcp.deps, {}));

		expect(message.attachments).toMatchObject([{ kind: 'image', included: true }]);
	});
});
