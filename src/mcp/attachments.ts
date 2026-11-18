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
 *
 * **Files travel too** (migration 026). The owner asked to be able to send agents
 * any file, and a file the agent cannot read is a file that was not sent. Two
 * shapes, because a tool result is text and bytes are not:
 *
 * - **Text-ish types go in as text** — a log, a CSV, JSON, source. That is the
 *   overwhelmingly common case and it is the one an agent can actually work in:
 *   quoting a line back is the whole point.
 * - **Everything else goes in as an embedded resource**, base64 in the block the
 *   protocol has for exactly this. A client that cannot use one still sees the
 *   note saying what was attached.
 *
 * A file gets a tighter ceiling than the shared budget: a 40MB archive would be
 * the agent's whole context spent on something it cannot read anyway.
 */
import {
	listMessageMedia,
	readAttachmentBytes,
	type DomainContext,
	type MediaSettings,
	type Message
} from '$domain';
import type { ContentBlock, ImageContent } from '@modelcontextprotocol/sdk/types.js';

/** How many images one `get_messages` call carries. */
export const MAX_INLINE_IMAGES = 4;

/**
 * How many bytes of image one call carries, before base64 inflates them.
 *
 * Deliberately modest: this is context an agent then has to work in, and a
 * screenshot that reads fine at 300KB does not read better at three megabytes.
 */
export const MAX_INLINE_BYTES = 3_000_000;

/**
 * How much of one file is inlined, before base64 inflates it.
 *
 * Smaller than the shared budget on purpose: a log worth reading is a few
 * hundred kilobytes, and an archive that is not is not worth an agent's window.
 */
export const MAX_INLINE_FILE_BYTES = 400_000;

/**
 * Types read as text rather than as bytes.
 *
 * `text/*` and the structured formats that are text with a name. Everything else
 * is a blob, which is the safe default: a mislabelled binary decoded as text is
 * a screenful of replacement characters.
 */
const TEXT_MIMES = new Set([
	'application/json',
	'application/xml',
	'application/yaml',
	'application/x-yaml',
	'application/toml',
	'application/x-ndjson',
	'application/javascript',
	'application/typescript',
	'application/sql',
	'application/x-sh',
	'image/svg+xml'
]);

/** Is this something worth handing over as characters? */
export function isTextMime(mime: string): boolean {
	if (mime.startsWith('text/')) return true;
	if (TEXT_MIMES.has(mime)) return true;
	return /\+(json|xml|yaml)$/.test(mime);
}

/**
 * Where an agent fetches the bytes themselves.
 *
 * The owner: "I sent a glb file, the agent cannot see it." A model, a zip, a
 * recording — anything past {@link MAX_INLINE_FILE_BYTES} — is not something to
 * paste into a tool result, but that was being reported as though the file were
 * simply unavailable. It is not: `/api/agent/media/:id` hands it over to the
 * agent's own token (`src/http/media/agent.ts`), so the answer is an address and
 * a `curl`, not an apology.
 *
 * `null` when this deployment has no `PUBLIC_BASE_URL` to build one from, in
 * which case the note says what the file is and stops there.
 */
export function downloadUrl(settings: MediaSettings | null, mediaId: string): string | null {
	const base = settings?.baseUrl?.replace(/\/+$/, '') ?? '';
	return base === '' ? null : `${base}/api/agent/media/${mediaId}`;
}

/**
 * One attachment, as the structured half of a tool result reports it.
 *
 * The notes below are prose in the summary, and prose is what a client is free
 * to collapse: the inkognito lead session was handed a 3.4MB `net_gun.glb`,
 * found "no blob, no file field and no summary note", and concluded the file had
 * not arrived. The note *was* sent — but only as text, and nothing in
 * `messages[]` said an attachment existed at all. So every attachment is now
 * also a row in the structured output, whether its bytes came with it or not,
 * with the address to fetch it from when they did not.
 */
export type AttachmentView = {
	media_id: string;
	kind: string;
	mime: string;
	bytes: number;
	/** What the owner called it, when they attached it by name. */
	filename: string | null;
	/** `ready`, or still being processed. */
	status: string;
	/** Whether the bytes are in this result, as an image, text or a blob. */
	included: boolean;
	/**
	 * Where to GET it with your own bearer token.
	 *
	 * Absent only on a deployment with no `PUBLIC_BASE_URL`, which has no
	 * reachable address to give.
	 */
	download_url?: string;
	/** Why the bytes are not here, when they are not. */
	reason?: string;
};

/** What one message's attachments amount to, for the agent reading it. */
export type MessageAttachments = {
	/** The blocks to append to the result: pictures, and the files themselves. */
	blocks: ContentBlock[];
	/**
	 * One line per message that has attachments, naming what was sent and what
	 * was not. Empty when nothing was attached anywhere.
	 */
	notes: string[];
	/**
	 * The same facts per message, by message id, for the structured result.
	 *
	 * A message with no attachments is absent rather than present and empty, so a
	 * caller can test the key.
	 */
	views: Record<string, AttachmentView[]>;
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
	const blocks: ContentBlock[] = [];
	const notes: string[] = [];
	const views: Record<string, AttachmentView[]> = {};
	let images = 0;
	let budget = MAX_INLINE_BYTES;

	for (const message of messages) {
		const attached = listMessageMedia(ctx, message.id);
		if (attached.length === 0) continue;
		if (settings === null) {
			notes.push(
				`message ${message.id}: ${attached.length} attachment(s), which this deployment cannot serve.`
			);
			views[message.id] = attached.map((item) =>
				view(settings, item, false, 'this deployment has no media configuration')
			);
			continue;
		}

		const sent: string[] = [];
		const skipped: string[] = [];
		const seen: AttachmentView[] = [];
		views[message.id] = seen;

		for (const item of attached) {
			if (item.kind === 'video') {
				// No protocol block carries a video, so this is the one case where
				// the bytes really are out of reach — but the file is not, and an
				// agent with ffmpeg can take a frame out of it itself.
				skipped.push(`${item.id} (video${fetchHint(settings, item.id)})`);
				seen.push(view(settings, item, false, 'no protocol block carries a video'));
				continue;
			}

			if (item.kind === 'file') {
				const name = item.filename ?? item.id;
				const block = await readFile(ctx, settings, item, Math.min(budget, MAX_INLINE_FILE_BYTES));
				if (!block) {
					// Named, measured, and addressed. "Too large to inline" on its own
					// reads as "you cannot have this", which was never true.
					skipped.push(
						`${name} (${item.mime}, ${item.bytes} bytes: too large to inline` +
							`${fetchHint(settings, item.id)})`
					);
					seen.push(
						view(
							settings,
							item,
							false,
							`too large to inline (over ${MAX_INLINE_FILE_BYTES} bytes, or no room left in this read)`
						)
					);
					continue;
				}

				budget -= block.bytes;
				blocks.push(block.block);
				sent.push(`${name} (${item.mime})`);
				seen.push(view(settings, item, true));
				continue;
			}

			if (images >= MAX_INLINE_IMAGES) {
				skipped.push(
					`${item.id} (over the ${MAX_INLINE_IMAGES}-image limit for one read` +
						`${fetchHint(settings, item.id)})`
				);
				seen.push(
					view(settings, item, false, `over the ${MAX_INLINE_IMAGES}-image limit for one read`)
				);
				continue;
			}

			const block = await readImage(ctx, settings, item.id, item.variants, budget);
			if (!block) {
				skipped.push(
					`${item.id} (too large to inline, or still being processed` +
						`${fetchHint(settings, item.id)})`
				);
				seen.push(view(settings, item, false, 'too large to inline, or still being processed'));
				continue;
			}

			budget -= block.bytes;
			images += 1;
			blocks.push(block.image);
			sent.push(item.id);
			seen.push(view(settings, item, true));
		}

		notes.push(describe(message.id, sent, skipped));
	}

	return { blocks, notes, views };
}

/** One attachment as the structured result reports it. */
function view(
	settings: MediaSettings | null,
	item: {
		id: string;
		kind: string;
		mime: string;
		bytes: number;
		filename: string | null;
		status: string;
	},
	included: boolean,
	reason?: string
): AttachmentView {
	const url = downloadUrl(settings, item.id);
	return {
		media_id: item.id,
		kind: item.kind,
		mime: item.mime,
		bytes: item.bytes,
		filename: item.filename,
		status: item.status,
		included,
		...(url === null ? {} : { download_url: url }),
		...(reason === undefined ? {} : { reason })
	};
}

/**
 * One file as a protocol block, or `undefined` if it will not fit.
 *
 * Text where text is meaningful, a base64 resource otherwise. The text form
 * carries the name and type on their own line above the content, because an
 * agent handed three logs has nothing else to tell them apart — and the fence is
 * there so a file that itself contains backticks cannot be read as the end of
 * the block.
 */
async function readFile(
	ctx: DomainContext,
	settings: MediaSettings,
	item: { id: string; mime: string; filename: string | null; variants: readonly string[] },
	maxBytes: number
): Promise<{ block: ContentBlock; bytes: number } | undefined> {
	if (maxBytes <= 0) return undefined;

	const found = await readAttachmentBytes(
		ctx,
		{ mediaId: item.id, variants: item.variants as never, maxBytes },
		settings
	);
	if (!found) return undefined;

	const name = item.filename ?? item.id;
	const bytes = found.bytes.byteLength;

	if (isTextMime(item.mime)) {
		const text = new TextDecoder().decode(found.bytes);
		return {
			bytes,
			block: {
				type: 'text',
				text: `Attached file ${JSON.stringify(name)} (${item.mime}, ${bytes} bytes):\n<<<FILE\n${text}\nFILE>>>`
			}
		};
	}

	return {
		bytes,
		block: {
			type: 'resource',
			resource: {
				// A name for the block, not an address: nothing dereferences this, and
				// an agent has no session to fetch a media route with anyway.
				uri: `attachment:${item.id}/${encodeURIComponent(name)}`,
				mimeType: item.mime,
				blob: Buffer.from(found.bytes).toString('base64')
			}
		}
	};
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
/** The " — fetch it at …" half of a note, or nothing when there is no base URL. */
function fetchHint(settings: MediaSettings | null, mediaId: string): string {
	const url = downloadUrl(settings, mediaId);
	return url === null ? '' : ` — fetch it with your bearer token at ${url}`;
}

function describe(messageId: string, sent: string[], skipped: string[]): string {
	const parts: string[] = [];
	if (sent.length > 0) {
		parts.push(
			sent.length === 1
				? `1 attachment is included below (${sent[0]})`
				: `${sent.length} attachments are included below (${sent.join(', ')})`
		);
	}
	if (skipped.length > 0) {
		parts.push(`not shown: ${skipped.join('; ')}`);
	}
	return `message ${messageId}: ${parts.join('; ')}.`;
}
