/**
 * `react` (migration 024) — say something in one character.
 *
 * The owner asked for reactions and said what they are for: "looking at, done,
 * agree, disagree, emotions etc, its a nice simple way to allow quick
 * communication", and noted it could stand in for `acknowledge`. It largely
 * can: an eyes reaction on a message is "I have this" without a sentence, and
 * it costs the owner nothing to read.
 *
 * The difference worth keeping in mind is what each one *claims*. `acknowledge`
 * with `thinking` is about right now — the dashboard hides it when the agent
 * goes offline, because an animation against a dead session is a lie. A
 * reaction is a fact about the past and stays. So: react to say what you think
 * of something, acknowledge to say you are working on it this minute.
 *
 * There is no argument for who is reacting: the reactor is resolved from the
 * bearer token (design §5).
 */
import { react } from '$domain';
import { z } from 'zod';
import { guard, ok, reactionView } from '../results';
import type { McpTool } from './types';

const inputSchema = {
	message_id: z
		.string()
		.describe(
			'The message to react to, from get_messages or post_message — your owner’s, another ' +
				'agent’s, or your own.'
		),
	emoji: z
		.string()
		.describe(
			'The emoji itself ("👀", "✅", "🎉"), or a shortcode: eyes, tick, done, +1, -1, tada, ' +
				'rocket, heart, thinking, warning, x, fire, smile. A word that is not one of those ' +
				'is refused — a reaction is a character, not a sentence.'
		),
	on: z
		.boolean()
		.optional()
		.describe(
			'true to react, false to take your reaction back. Omit it and the call toggles, which ' +
				'is convenient by hand and wrong in a retry: if you may call this twice, say which ' +
				'way you mean.'
		)
};

export const reactTool: McpTool<typeof inputSchema> = {
	name: 'react',
	config: {
		title: 'React to a message with an emoji',
		description: [
			'React to a message with an emoji: 👀 to say you are looking at it, ✅ when it is done,',
			'👍 or 👎 to agree or disagree, 🎉 when something landed. It appears on the message',
			'itself, live, and costs your owner nothing to read.',
			'',
			'This is the cheapest thing you can say, and cheap matters: a card that has been reacted',
			'to is a card somebody has seen, and silence is what makes an owner wonder whether you',
			'are there at all.',
			'',
			'Arguments:',
			'- message_id (required): the message, from get_messages or post_message.',
			'- emoji (required): the character itself, or one of these shortcodes — eyes, tick,',
			'  done, +1, -1, tada, rocket, heart, thinking, warning, x, fire, smile.',
			'- on (optional): true to react, false to remove it. Omitted it toggles; pass it',
			'  explicitly if a retry is possible, or a second attempt will undo the first.',
			'',
			'Returns { reactions: [{ id, message_id, actor, emoji, created_at }], on }. `actor` is',
			'the literal "human" for your owner or "agent:<agent_id>", so you can see who else has',
			'reacted; `on` is whether your own reaction is there now.',
			'',
			'Reacting is not replying. Anything that needs words is post_message, and an emoji is a',
			'poor way to answer a question — your owner cannot tell "👍 I agree" from "👍 I have',
			'read this" when they asked you which of two things to do.',
			'',
			'On failure: "not_found" means no such message, or one that has been deleted.',
			'"invalid_argument" means what you sent is not an emoji — a word, a sentence, or',
			'something far too long.'
		].join('\n'),
		inputSchema,
		annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false }
	},

	run: ({ ctx, agent }, args) =>
		guard(() => {
			const result = react(ctx, {
				messageId: args.message_id,
				// Identity comes from the token, never from `args` (design §5).
				actor: { kind: 'agent', agentId: agent.id },
				emoji: args.emoji,
				...(args.on === undefined ? {} : { on: args.on })
			});

			return ok(
				result.on
					? `Reacted. Your owner sees it on the message.`
					: `Reaction removed. It is gone from the message.`,
				{ reactions: result.reactions.map(reactionView), on: result.on }
			);
		})
};
