/**
 * Handing an agent the pictures, not just the sentence about them.
 *
 * The owner attaches a screenshot to a message and asks what is wrong with it.
 * Until this existed `get_messages` returned the words and nothing else, so the
 * agent answered "I cannot see your image" — which is the whole exchange
 * failing at the last inch, and it is what the owner reported.
 *
 * The bytes have to travel *in the tool result*. An agent cannot fetch
 * `/media/:id/:variant`: that route wants the owner's session cookie, and it is
 * right to (design §8) — media is not public, and an agent's bearer token is not
 * a licence to walk the media tree. So the image rides back as an MCP image
 * content block, which is the one channel that already exists for this.
 *
 * Three limits, because a tool result is somebody's context window:
 *
 * - **A derivative before the original.** `thumb-1600` is a readable screenshot
 *   at a fraction of the size, and it is what the dashboard itself shows.
 * - **A few images, not a gallery.** {@link MAX_INLINE_IMAGES} per call, oldest
 *   first, so a conversation with one picture in it always carries that picture.
 * - **A byte ceiling.** Base64 costs a third more again, and an agent that spent
 *   its window on photographs would have none left for the work.
 *
 * Anything left out is *said* rather than dropped in silence: the summary names
 * what could not be inlined, so the agent knows to ask the owner rather than
 * assuming it has seen everything. Video is never inlined — there is no protocol
 * block for it — and is described the same way.
 */
import {
	listMessageMedia,
	readAttachmentBytes,
	type DomainContext,
	type MediaSettings,
	type Message
} from '$domain';
import type { ImageContent } from '@modelcontextprotocol/sdk/types.js';

/** How many images one `get_messages` call carries. */
export const MAX_INLINE_IMAGES = 4;

/**
 * How many bytes of image one call carries, before base64 inflates them.
 *
 * Deliberately modest: this is context an agent then has to work in, and a
 * screenshot that reads fine at 300KB does not read better at three megabytes.
 */
export const MAX_INLINE_BYTES = 3_000_000;

/** What one message's attachments amount to, for the agent reading it. */
export type MessageAttachments = {
	/** The image blocks to append to the result. */
	images: ImageContent[];
	/**
	 * One line per message that has attachments, naming what was sent and what
	 * was not. Empty when nothing was attached anywhere.
	 */
	notes: string[];
};

/**
 * Read the images on a page of messages.
 *
 * Never throws for a file that is missing or a variant that has not been
 * generated: an attachment that cannot be read is reported in the notes and the
 * words still arrive. A `get_messages` that failed because a thumbnail was mid
 * generation would be a worse product than one that says "still processing".
 */
export async function attachmentsFor(
	ctx: DomainContext,
	/** `null` for a deployment with no media configured: the words still arrive. */
	settings: MediaSettings | null,
	messages: readonly Message[]
): Promise<MessageAttachments> {
	const images: ImageContent[] = [];
	const notes: string[] = [];
	let budget = MAX_INLINE_BYTES;

	for (const message of messages) {
		const attached = listMessageMedia(ctx, message.id);
		if (attached.length === 0) continue;
		if (settings === null) {
			notes.push(
				`message ${message.id}: ${attached.length} attachment(s), which this deployment cannot serve.`
			);
			continue;
		}

		const sent: string[] = [];
		const skipped: string[] = [];

		for (const item of attached) {
			if (item.kind !== 'image') {
				skipped.push(`${item.id} (${item.kind}, ask your owner to describe it)`);
				continue;
			}
			if (images.length >= MAX_INLINE_IMAGES) {
				skipped.push(`${item.id} (over the ${MAX_INLINE_IMAGES}-image limit for one read)`);
				continue;
			}

			const block = await readImage(ctx, settings, item.id, item.variants, budget);
			if (!block) {
				skipped.push(`${item.id} (too large to inline, or still being processed)`);
				continue;
			}

			budget -= block.bytes;
			images.push(block.image);
			sent.push(item.id);
		}

		notes.push(describe(message.id, sent, skipped));
	}

	return { images, notes };
}

/** One image as a protocol block, or `undefined` if it cannot be sent. */
async function readImage(
	ctx: DomainContext,
	settings: MediaSettings,
	mediaId: string,
	variants: readonly string[],
	budget: number
): Promise<{ image: ImageContent; bytes: number } | undefined> {
	// Which variant, and whether it can be read at all, is the domain's business:
	// `$mcp` may not reach into `$media` (design §2), and this layer's job is the
	// shape of a tool result rather than the shape of the disk.
	const found = await readAttachmentBytes(
		ctx,
		{ mediaId, variants: variants as never, maxBytes: budget },
		settings
	);
	if (!found) return undefined;

	return {
		bytes: found.bytes.byteLength,
		image: {
			type: 'image',
			data: Buffer.from(found.bytes).toString('base64'),
			mimeType: found.mime
		}
	};
}

/** What to tell the agent about one message's attachments. */
function describe(messageId: string, sent: string[], skipped: string[]): string {
	const parts: string[] = [];
	if (sent.length > 0) {
		parts.push(
			sent.length === 1
				? `1 image is attached below (${sent[0]})`
				: `${sent.length} images are attached below (${sent.join(', ')})`
		);
	}
	if (skipped.length > 0) {
		parts.push(`not shown: ${skipped.join('; ')}`);
	}
	return `message ${messageId}: ${parts.join('; ')}.`;
}
