/**
 * `tag_card` and `list_tags` (migration 039) — a project's own words.
 *
 * The owner: "allow users and agents to define tags for a project, ie 'feature,
 * bug, high priority' etc, and these can be included on feed posts by agents and
 * users in one click."
 *
 * A tag is not a level and not a work state. Those are closed lists the product
 * decides; a tag is whatever this project calls things, decided by whoever works
 * there — the owner in the picker, or an agent from here.
 */
import { TAGS_PER_CARD, listTags, oneCard, tagCard } from '$domain';
import { z } from 'zod';
import { guard, ok } from '../results';
import type { McpTool } from './types';

const listSchema = {
	project: z
		.string()
		.optional()
		.describe('Which project`s words: its slug or its 26-character id. Omit for every project.')
};

export const listTagsTool: McpTool<typeof listSchema> = {
	name: 'list_tags',
	config: {
		title: 'List a project’s tags',
		description: [
			'The words a project uses to label its cards — "bug", "feature", "high priority",',
			'whatever this project decided. Read this before tagging something, so you use the word',
			'that is already there rather than inventing a second one that means the same thing.',
			'',
			'Arguments:',
			'- project (optional): a slug or a 26-character id. Omit for every project.',
			'',
			'Returns { tags: [{ id, project_id, name, colour, agent_id, created_at }], count }.',
			'`agent_id` is who defined it, or null for your owner. An empty list is a normal',
			'answer: the project has not decided any words yet, and tag_card can define the first.'
		].join('\n'),
		inputSchema: listSchema,
		annotations: { readOnlyHint: true, openWorldHint: false }
	},

	run: ({ ctx }, args) =>
		guard(() => {
			const tags = listTags(ctx, args.project === undefined ? {} : { project: args.project });
			const summary =
				tags.length === 0
					? 'No tags yet. tag_card with create: true decides the first one.'
					: `${tags.length} tag${tags.length === 1 ? '' : 's'}: ${tags
							.map((tag) => tag.name)
							.join(', ')}.`;

			return ok(summary, {
				tags: tags.map((tag) => ({
					id: tag.id,
					project_id: tag.projectId,
					name: tag.name,
					colour: tag.colour,
					agent_id: tag.agentId,
					created_at: new Date(tag.createdAt).toISOString()
				})),
				count: tags.length
			});
		})
};

const tagSchema = {
	update_id: z.string().optional().describe('The update to label, from post_update.'),
	message_id: z
		.string()
		.optional()
		.describe('A post or a reply to label instead, from get_messages or a channel event.'),
	request_id: z.string().optional().describe('A question of yours to label instead.'),
	tag: z
		.string()
		.describe(
			'The word, e.g. "bug", or a tag id from list_tags. Matched case-insensitively, so ' +
				'"Bug" and "bug" are the same tag.'
		),
	on: z
		.boolean()
		.optional()
		.describe('true to put it on, false to take it off. Omit to toggle it.'),
	create: z
		.boolean()
		.optional()
		.describe(
			'Define the word for this project if it does not have it yet. Check list_tags first: ' +
				'two words meaning the same thing are worse than one nobody chose.'
		)
};

export const tagCardTool: McpTool<typeof tagSchema> = {
	name: 'tag_card',
	config: {
		title: 'Put one of the project’s words on a card',
		description: [
			'Label a card with one of the project`s tags — "bug", "feature", "needs design",',
			'whatever this project uses. Your owner sees it on the card and can filter by it.',
			'',
			'Arguments (name exactly one card):',
			'- update_id: an update, from post_update.',
			'- message_id: a post or a reply, from get_messages or a channel event.',
			'- request_id: a question you raised with request_input.',
			'- tag (required): the word, or an id from list_tags.',
			'- on (optional): true to put it on, false to take it off. Omit to toggle.',
			'- create (optional): define the word for this project if it is not defined yet.',
			'',
			'Call list_tags first. A project with "bug" does not need "bugs" as well, and the',
			'point of a shared vocabulary is that the same thing has one name.',
			'',
			`A card may carry at most ${TAGS_PER_CARD} tags — a card wearing a dozen labels says`,
			'nothing. A tag belongs to a project, so a card can only ever wear its own project`s',
			'words.',
			'',
			'Returns { card: { kind, id }, tag: { id, name, colour }, on }.',
			'',
			'On failure: "not_found" means no such card, or a word this project has not defined',
			'(pass create: true, or check list_tags). "invalid_argument" means you named no card or',
			'more than one, a word belonging to another project, or a card that is already full.'
		].join('\n'),
		inputSchema: tagSchema,
		annotations: { idempotentHint: true, destructiveHint: false, openWorldHint: false }
	},

	run: ({ ctx, agent }, args) =>
		guard(() => {
			const result = tagCard(ctx, {
				card: oneCard({
					update: args.update_id,
					message: args.message_id,
					request: args.request_id
				}),
				tag: args.tag,
				actor: { kind: 'agent', agentId: agent.id },
				...(typeof args.on === 'boolean' ? { on: args.on } : {}),
				...(args.create === true ? { create: true } : {})
			});

			return ok(
				result.on
					? `Tagged ${JSON.stringify(result.tag.name)}. Your owner sees it on the card.`
					: `Took ${JSON.stringify(result.tag.name)} off.`,
				{
					card: result.card,
					tag: { id: result.tag.id, name: result.tag.name, colour: result.tag.colour },
					on: result.on
				}
			);
		})
};
