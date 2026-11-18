/**
 * `create_upload` (design §5, §6) — step one of the two-step upload.
 *
 * Agents have no local install, so they cannot hand this server a path (design
 * §2). They ask for somewhere to PUT instead, and get back an **absolute** URL
 * built from `PUBLIC_BASE_URL`: an agent runs on another machine, so a
 * `127.0.0.1` URL would be an upload it can never perform (design §12).
 *
 * The tool description carries the whole protocol — reserve, PUT, then reference
 * the id — because an agent reads this once and has to get the sequence right
 * without a round trip to ask what `upload_url` is for.
 */
import { ALLOWED_MIMES, DOWNLOAD_MIME, FILENAME_MAX_LENGTH, createUpload } from '$domain';
import { z } from 'zod';
import { guard, ok } from '../results';
import type { McpTool } from './types';

const inputSchema = {
	filename: z
		.string()
		.max(FILENAME_MAX_LENGTH)
		.describe(
			`What the file is called, e.g. "login-error.png" or "build.log", at most ` +
				`${FILENAME_MAX_LENGTH} characters. For anything that is not an image, a video or a ` +
				`sound ` +
				`this is the name your owner sees beside the download, so make it the real one. ` +
				`It never names anything on the server.`
		),
	mime: z
		.string()
		.describe(
			`The type of the file, as "type/subtype". Two cases. If it is one of ` +
				`${ALLOWED_MIMES.join(', ')} it is shown on the card as a picture or a player, and ` +
				`the bytes must really be that type — the server checks the magic bytes and rejects ` +
				`a mismatch, and SVG is never rendered. Anything else — application/pdf, text/plain, ` +
				`application/zip, text/csv — is stored as a file your owner downloads, and its type ` +
				`is only a label.`
		),
	bytes: z
		.number()
		.int()
		.positive()
		.describe(
			'The exact size of the file in bytes. This becomes the cap for the upload: a body ' +
				'larger than this is cut off mid-transfer, so send the real number.'
		)
};

export const createUploadTool: McpTool<typeof inputSchema> = {
	name: 'create_upload',
	config: {
		title: 'Reserve an upload',
		description: [
			'Reserve somewhere to put a file, so you can show the owner the thing itself instead of',
			'describing it: a screenshot, a screen recording, a voice note, a PDF, a log, a CSV,',
			'an archive.',
			'',
			'Three steps, in this order:',
			'',
			'1. Call create_upload with the name, type and exact size of the file.',
			'2. PUT the raw bytes — the file itself, no multipart wrapper, no base64 — to the',
			'   upload_url you get back. It is absolute; use it exactly as given.',
			'   You MUST send a Content-Type header. A PUT with no Content-Type has its body',
			`   discarded before it reaches the server. Send "${DOWNLOAD_MIME}" unless you are`,
			'   uploading an image, a video or a sound, in which case send the mime you declared',
			'   here.',
			'   Never send a form-like type (text/plain, multipart/form-data,',
			'   application/x-www-form-urlencoded): those are refused as cross-site form posts,',
			`   which is why a text file is PUT as "${DOWNLOAD_MIME}" even though you declared it`,
			'   as text/plain. The header does not decide anything — the type you declared here is',
			'   what gets stored. Note that fetch(url, { method: "PUT", body: buffer }) sends NO',
			'   Content-Type by default; set it explicitly.',
			'3. Pass the media_id to post_update as media_ids (or to attach_media if the update is',
			'   already posted).',
			'',
			'Arguments:',
			`- filename (required): what the file is called, at most ${FILENAME_MAX_LENGTH}`,
			'  characters. Shown beside the download for anything that is not an image, a video or',
			'  a sound, so use the real name. It names nothing on the server.',
			'- mime (required): "type/subtype".',
			`  ${ALLOWED_MIMES.join(', ')} are rendered on the card, and for those the bytes must`,
			'  really be that type, because the server checks the magic bytes. Anything else is',
			'  stored as a file the owner downloads; its type is a label only, and the bytes are',
			'  not sniffed. SVG is never rendered, but may be uploaded as a file.',
			'- bytes (required): the exact byte length of the file.',
			'',
			'The upload URL is single use and expires 15 minutes after it is issued. The PUT answers',
			'201 with the stored size and type; 400 means the body did not arrive (almost always a',
			'missing Content-Type — the token is NOT spent, so retry the same upload_url), 403 means',
			'the token was already used or has expired (call this tool again), 413 means the body was',
			'larger than the size you declared, and 415 means the bytes are not the type you declared',
			'(rendered types only: images, video and sound).',
			'',
			'Returns { media_id, upload_url, expires_at, max_bytes }. On failure: error',
			'"invalid_argument" means the type is not a mime at all, or the size is not a positive',
			'number of bytes, or it is over the limit this deployment sets for that kind of file.',
			'Images, video and files each have their own limit; sound shares the file limit.'
		].join('\n'),
		inputSchema,
		annotations: { idempotentHint: false, destructiveHint: false, openWorldHint: false }
	},

	run: ({ ctx, agent }, args) =>
		guard(() => {
			const grant = createUpload(ctx, {
				// Identity comes from the token, never from `args` (design §5).
				agentId: agent.id,
				filename: args.filename,
				mime: args.mime,
				bytes: args.bytes
			});

			return ok(
				`Reserved ${args.mime} upload ${grant.mediaId}. PUT the raw bytes to ${grant.uploadUrl} ` +
					`within 15 minutes, then pass ${grant.mediaId} to post_update as media_ids.`,
				{
					media_id: grant.mediaId,
					upload_url: grant.uploadUrl,
					expires_at: new Date(grant.expiresAt).toISOString(),
					max_bytes: grant.maxBytes
				}
			);
		})
};
