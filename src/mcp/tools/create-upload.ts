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
import { ALLOWED_MIMES, FILENAME_MAX_LENGTH, createUpload } from '$domain';
import { z } from 'zod';
import { guard, ok } from '../results';
import type { McpTool } from './types';

const inputSchema = {
	filename: z
		.string()
		.max(FILENAME_MAX_LENGTH)
		.describe(
			`What the file is called, e.g. "login-error.png", at most ${FILENAME_MAX_LENGTH} ` +
				`characters. A label for your own benefit: it is not stored and it does not name ` +
				`anything on the server.`
		),
	mime: z
		.string()
		.describe(
			`The type of the file. One of: ${ALLOWED_MIMES.join(', ')}. Nothing else is accepted — ` +
				`SVG in particular is always refused — and the bytes you upload must really be this ` +
				`type, because the server checks the file's magic bytes and rejects a mismatch.`
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
			'Reserve somewhere to put an image or a video, so you can show the owner what you are',
			'talking about instead of describing it.',
			'',
			'Three steps, in this order:',
			'',
			'1. Call create_upload with the name, type and exact size of the file.',
			'2. PUT the raw bytes — the file itself, no multipart wrapper, no base64 — to the',
			'   upload_url you get back. It is absolute; use it exactly as given.',
			'3. Pass the media_id to post_update as media_ids (or to attach_media if the update is',
			'   already posted).',
			'',
			'Arguments:',
			`- filename (required): what the file is called, at most ${FILENAME_MAX_LENGTH}`,
			'  characters. A label only; it is stored nowhere.',
			`- mime (required): one of ${ALLOWED_MIMES.join(', ')}. SVG is never accepted.`,
			'- bytes (required): the exact byte length of the file.',
			'',
			'The upload URL is single use and expires 15 minutes after it is issued. The PUT answers',
			'201 with the stored size and type; 403 means the token was already used or has expired',
			'(call this tool again), 413 means the body was larger than the size you declared, and',
			'415 means the bytes are not the type you declared.',
			'',
			'Returns { media_id, upload_url, expires_at, max_bytes }. On failure: error',
			'"invalid_argument" means the type is not on the allowlist, or the size is not a positive',
			'number of bytes, or it is over the limit this deployment sets for that kind of file.'
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
