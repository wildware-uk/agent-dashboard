import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProject, postMessage, uploadOwnerMedia } from '$domain';
import { bodyOf, pngBytes, tempSettings } from '$media/testing';
import { mcpHarness, toolText, type McpHarness } from './testing';
import { getMessagesTool } from './tools';
import { MAX_INLINE_IMAGES } from './attachments';

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
	const bytes = pngBytes();
	const media = await uploadOwnerMedia(
		mcp.h,
		{
			filename: 'shot.png',
			mime: 'image/png',
			body: bodyOf(bytes),
			contentLength: bytes.length
		},
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

		expect(said).toContain('1 image is attached below');
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
