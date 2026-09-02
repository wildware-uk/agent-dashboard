/**
 * `edit_update` (design §5) — an agent corrects a card it already posted.
 *
 * The author comes from `deps.agent`, resolved from the bearer token, and the
 * domain refuses an update posted by anybody else: agents share one timeline,
 * and a tool that let one rewrite another's report would make the whole wall
 * unreliable in exactly the way it must not be.
 *
 * Deliberately narrow. An edit may change the title, the body and the level —
 * the three things the agent authored — and nothing else. Not the project (the
 * card would vanish from one timeline and appear in another), not the pin (the
 * owner's control, not the agent's), and not `created_at` (a corrected typo
 * would jump the card to the top of the feed).
 *
 * Media is absent for the same reason `post_update` refuses unknown ids rather
 * than dropping them: attaching is `attach_media`'s job and detaching is nobody's
 * yet, so an argument that half worked would be worse than no argument.
 */
import { BODY_MAX_LENGTH, TITLE_MAX_LENGTH, editUpdate } from '$domain';
import { z } from 'zod';
import { guard, ok, updateView } from '../results';
import type { McpTool } from './types';

const inputSchema = {
	update_id: z
		.string()
		.describe(
			'The 26-character id of the update to edit, as post_update returned it. It must be one ' +
				'of your own updates.'
		),
	body: z
		.string()
		.max(BODY_MAX_LENGTH)
		.optional()
		.describe(
			`The replacement body, as markdown, at most ${BODY_MAX_LENGTH} characters. Omit to ` +
				`leave the body alone. This replaces the whole body rather than appending to it.`
		),
	title: z
		.string()
		.max(TITLE_MAX_LENGTH)
		.nullable()
		.optional()
		.describe(
			`The replacement headline, at most ${TITLE_MAX_LENGTH} characters. Omit to leave it ` +
				`alone; pass null to remove the headline entirely.`
		),
	priority: z
		.enum(['low', 'medium', 'high'])
		.optional()
		.describe(
			'How much this needs your owner NOW: "low", "medium" (the default) or "high". A ' +
				'different question from level — level is what happened, priority is whether it can ' +
				'wait. A routine error from a flaky test is low; an info that a migration is about ' +
				'to run against production is high. Your owner filters notifications on this, per ' +
				'device, so "high" is what reaches a phone at 2am. Use it sparingly or it stops ' +
				'meaning anything.'
		),
	level: z
		.enum(['info', 'success', 'warn', 'error'])
		.optional()
		.describe(
			'The corrected level: "info", "success", "warn" or "error". Omit to leave it alone. ' +
				'Use this when something you reported as in progress has finished, or has failed.'
		)
};

export const editUpdateTool: McpTool<typeof inputSchema> = {
	name: 'edit_update',
	config: {
		title: 'Edit an update you posted',
		description: [
			'Correct an update you have already posted. Use it when what you said has stopped being',
			'true — a step you reported as running has finished, a number was wrong, a level was too',
			'alarming or not alarming enough.',
			'',
			'Arguments:',
			'- update_id (required): the id post_update returned. Only your own updates.',
			`- body (optional): the replacement markdown, at most ${BODY_MAX_LENGTH} characters. It`,
			'  replaces the body; it does not append to it.',
			`- title (optional): the replacement headline, at most ${TITLE_MAX_LENGTH} characters, or`,
			'  null to remove it.',
			'- level (optional): "info", "success", "warn" or "error".',
			'- priority (optional): "low", "medium" or "high". Demote something that has stopped',
			'  mattering rather than leaving it shouting.',
			'',
			'At least one of body, title, level or priority must be given.',
			'',
			'The card keeps its place in the timeline and is marked as edited, so the owner can see',
			'that what they read earlier has changed. There is no revision history: the new text is',
			'the only text. If the update is wrong in a way a correction cannot fix, post a new one',
			'rather than rewriting history the owner has already acted on.',
			'',
			'Prefer this over posting a near-duplicate card. Do not use it to keep one card as a',
			'running log — the timeline is a sequence of things that happened, and an owner who',
			'scrolled past your card will not see it change.',
			'',
			'Returns { update: { id, project_id, agent_id, session_id, title, level, pinned,',
			'body_chars, created_at, edited_at } }.',
			'',
			'On failure: "not_found" means there is no such update, or it has been deleted — a',
			'deleted card cannot be edited back into existence. "invalid_argument" means the update',
			'belongs to another agent, the body was empty or too long, or you passed no fields to',
			'change. Nothing is written when either happens.'
		].join('\n'),
		inputSchema,
		annotations: { idempotentHint: true, destructiveHint: false, openWorldHint: false }
	},

	run: ({ ctx, agent }, args) =>
		guard(() => {
			const update = editUpdate(ctx, {
				updateId: args.update_id,
				// Identity comes from the token, never from `args` (design §5).
				agentId: agent.id,
				body: args.body,
				title: args.title,
				level: args.level,
				priority: args.priority
			});

			return ok(`Edited update ${update.id}.`, { update: updateView(update) });
		})
};
