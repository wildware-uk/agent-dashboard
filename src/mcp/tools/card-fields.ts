/**
 * `set_card_field` and `get_card_fields` (migration 040).
 *
 * The owner: "allow agents to set metadata on cards, for example, branch name,
 * PR link, anything they like, they are hidden by default, but can be viewed on
 * the dashboard, and updated by the user and agent alike."
 *
 * The point is to stop facts like these being written into prose. "I pushed to
 * `fix/fees`" inside a paragraph is a sentence somebody has to read and
 * remember; a field called `branch` is one the card carries, the owner can
 * correct, and the next agent can look up.
 */
import {
	FIELDS_PER_CARD,
	FIELD_VALUE_MAX,
	fieldsOn,
	oneCard,
	setField,
	type CardField
} from '$domain';
import { z } from 'zod';
import { guard, ok } from '../results';
import type { McpTool } from './types';

/** The shape a field takes on the wire. */
function fieldView(field: CardField) {
	return {
		name: field.name,
		value: field.value,
		author: field.author,
		created_at: new Date(field.createdAt).toISOString(),
		updated_at: new Date(field.updatedAt).toISOString()
	};
}

const cardArgs = {
	update_id: z.string().optional().describe('The update, from post_update.'),
	message_id: z
		.string()
		.optional()
		.describe('A post or a reply instead, from get_messages or a channel event.'),
	request_id: z.string().optional().describe('A question of yours instead.')
};

const setSchema = {
	...cardArgs,
	name: z
		.string()
		.describe(
			'What the field is called, e.g. "branch", "PR link", "environment". Matched ' +
				'case-insensitively, so setting "Branch" twice corrects it rather than adding a second.'
		),
	value: z
		.string()
		.nullable()
		.describe(
			`What it says, at most ${FIELD_VALUE_MAX} characters, or null to take the field off ` +
				'the card. A link is rendered as one; everything else is shown as text.'
		)
};

export const setCardFieldTool: McpTool<typeof setSchema> = {
	name: 'set_card_field',
	config: {
		title: 'Note something on a card',
		description: [
			'Put a fact on a card where it can be found later: the branch you are working on, the',
			'pull request you opened, the environment you deployed to, a ticket id — anything the',
			'next person needs and should not have to read a paragraph to get.',
			'',
			'They are hidden behind a "Details" toggle on the card, so a card with six fields on it',
			'still reads as what somebody said.',
			'',
			'Arguments (name exactly one card):',
			'- update_id / message_id / request_id: the card.',
			'- name (required): what the field is called.',
			'- value (required): what it says, or null to take the field off.',
			'',
			'**Your owner can correct what you write, and you can correct theirs.** A branch name is',
			'a fact about the job rather than something somebody said, so nobody owns it — but the',
			'card records who touched each field last, so a wrong value can be traced.',
			'',
			`A card carries at most ${FIELDS_PER_CARD} fields. Setting the same name again corrects`,
			'the value in place.',
			'',
			'Returns { card: { kind, id }, fields: [{ name, value, author, created_at, updated_at }],',
			'set } — every field on the card afterwards, so you need not read it back.',
			'',
			'On failure: "not_found" means no such card, or clearing a field that is not there.',
			'"invalid_argument" means no card or more than one, an empty name or value, something',
			'past its limit, or a card that is already full.'
		].join('\n'),
		inputSchema: setSchema,
		annotations: { idempotentHint: true, destructiveHint: false, openWorldHint: false }
	},

	run: ({ ctx, agent }, args) =>
		guard(() => {
			const result = setField(ctx, {
				card: oneCard({
					update: args.update_id,
					message: args.message_id,
					request: args.request_id
				}),
				name: args.name,
				value: args.value,
				actor: { kind: 'agent', agentId: agent.id }
			});

			return ok(
				result.set
					? `Noted ${JSON.stringify(args.name)} on the card. Your owner can see it under Details.`
					: `Took ${JSON.stringify(args.name)} off the card.`,
				{ card: result.card, fields: result.fields.map(fieldView), set: result.set }
			);
		})
};

export const getCardFieldsTool: McpTool<typeof cardArgs> = {
	name: 'get_card_fields',
	config: {
		title: 'Read what is noted on a card',
		description: [
			'Read the fields on a card — the branch, the pull request, whatever has been noted on',
			'it, by you, by another agent or by your owner.',
			'',
			'Use it before you start on something another agent has touched: the card is where the',
			'facts about the job live, and asking here beats reading the whole thread.',
			'',
			'Arguments (name exactly one card):',
			'- update_id / message_id / request_id: the card.',
			'',
			'Returns { card: { kind, id }, fields: [{ name, value, author, created_at, updated_at }],',
			'count }. `author` is "human" for your owner or "agent:<id>". An empty list is a normal',
			'answer: nothing has been noted on that card yet.',
			'',
			'On failure: "not_found" means no such card. "invalid_argument" means you named no card',
			'or more than one.'
		].join('\n'),
		inputSchema: cardArgs,
		annotations: { readOnlyHint: true, openWorldHint: false }
	},

	run: ({ ctx }, args) =>
		guard(() => {
			const card = oneCard({
				update: args.update_id,
				message: args.message_id,
				request: args.request_id
			});
			const fields = fieldsOn(ctx, card);

			return ok(
				fields.length === 0
					? 'Nothing noted on that card yet.'
					: `${fields.length} field${fields.length === 1 ? '' : 's'}: ${fields
							.map((field) => field.name)
							.join(', ')}.`,
				{ card, fields: fields.map(fieldView), count: fields.length }
			);
		})
};
