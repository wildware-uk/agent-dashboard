/**
 * `list_work` (migration 035) — what is being worked on, and what state it is in.
 *
 * The owner: "allow agents to filter cards by work status, ie get all cards in
 * project x that are status y."
 *
 * The dashboard grew filter chips for exactly this question and agents had no
 * way to ask it, which left "what is blocked here" as something only a human
 * could look up. This is the same query against the same rows.
 *
 * A read: nothing is written and nothing is published.
 */
import { CARD_STATUSES, listWorkInScope, type CardStatus } from '$domain';
import { z } from 'zod';
import { guard, ok } from '../results';
import type { McpTool } from './types';

/** A page big enough to plan from, small enough not to be a feed dump. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const inputSchema = {
	project: z
		.string()
		.optional()
		.describe(
			'Which project to look in: its slug ("agent-dashboard") or its 26-character id. Omit ' +
				'to search every project you work in.'
		),
	status: z
		.array(z.enum(CARD_STATUSES))
		.optional()
		.describe(
			'The states you want, e.g. ["blocked"] or ["todo", "in_progress"]. Omit for every ' +
				'card that carries a state at all.'
		),
	limit: z
		.number()
		.int()
		.positive()
		.max(MAX_LIMIT)
		.optional()
		.describe(`How many at most, newest movement first. Default ${DEFAULT_LIMIT}.`)
};

export const listWorkTool: McpTool<typeof inputSchema> = {
	name: 'list_work',
	config: {
		title: 'List work, by state',
		description: [
			'List the cards that are work — the ones somebody has marked with set_status — filtered',
			'by which state they are in. This is what the task board used to be: "everything blocked',
			'in the exchange project" is one call.',
			'',
			'Arguments:',
			'- project (optional): a slug or a 26-character id. Omit to search every project you',
			'  work in, which is worked out from what you have actually posted and replied to.',
			'- status (optional): an array of "todo", "in_progress", "blocked", "done",',
			'  "cancelled". Omit for every card carrying any state.',
			`- limit (optional): at most ${MAX_LIMIT}, default ${DEFAULT_LIMIT}.`,
			'',
			'Newest movement first — when the state last changed, not when the card was written —',
			'so what somebody has just picked up or just been blocked on is at the top.',
			'',
			'Use it before you start something, so you do not take work another agent has already',
			'marked "in_progress", and use it with ["blocked"] when you have capacity: a blocked',
			'card is where the project is actually stuck.',
			'',
			'Returns { work: [{ kind, id, project_id, status, title, summary, author, created_at,',
			'status_at }], count }. `kind` is "update" or "message" and `id` with it is what',
			'set_status, post_message and react take. `summary` is the start of the card, not the',
			'whole of it — read the card with get_messages, or reply to it, if you need the rest.',
			'',
			'On failure: "not_found" means no such project (call list_projects).',
			'"invalid_argument" means a state that is not one of the five.'
		].join('\n'),
		inputSchema,
		annotations: { readOnlyHint: true, openWorldHint: false }
	},

	run: ({ ctx, agent }, args) =>
		guard(() => {
			const work = listWorkInScope(ctx, agent.id, {
				...(args.project === undefined ? {} : { project: args.project }),
				...(args.status === undefined ? {} : { statuses: args.status as CardStatus[] }),
				limit: args.limit ?? DEFAULT_LIMIT
			});

			const counts = new Map<string, number>();
			for (const item of work) counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
			const summary =
				work.length === 0
					? 'No work matches. Nothing is marked in that state.'
					: `${work.length} card${work.length === 1 ? '' : 's'}: ${[...counts]
							.map(([status, count]) => `${count} ${status.replace('_', ' ')}`)
							.join(', ')}.`;

			return ok(summary, {
				work: work.map((item) => ({
					kind: item.kind,
					id: item.id,
					project_id: item.projectId,
					status: item.status,
					title: item.title,
					summary: item.summary,
					author: item.author,
					created_at: new Date(item.createdAt).toISOString(),
					status_at: item.statusAt === null ? null : new Date(item.statusAt).toISOString()
				})),
				count: work.length
			});
		})
};
