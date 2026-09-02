/**
 * One task, and the work under it (design §7).
 *
 * The feed answers "what happened" and is read newest-first and forgotten; a
 * task answers "what is being worked on", and outlives any one thing that
 * happened during it. This page is the second question: the task, its state, who
 * has it, and every update an agent filed against it.
 *
 * A plain server render rather than a live store. A task page is opened to read
 * a history, not watched — and the history it shows is already live in the feed,
 * which is where an owner watching for movement is looking. Anything that
 * arrives while this page is open is one reload away, which is the honest cost
 * of not holding a second stream open per task.
 */
import { error } from '@sveltejs/kit';
import {
	context,
	findProject,
	findTask,
	listAgentNames,
	listThread,
	listUpdateMedia,
	listUpdates
} from '$domain';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ params }) => {
	const ctx = context();
	const task = findTask(ctx, params.id);
	if (!task) error(404, 'not found');

	const page = listUpdates(ctx, { taskId: task.id, limit: 200 });
	const media = listUpdateMedia(
		ctx,
		page.updates.map((update) => update.id)
	);

	return {
		task,
		project: findProject(ctx, task.projectId) ?? null,
		updates: page.updates.map((update) => ({ ...update, media: media[update.id] ?? [] })),
		messages: listThread(ctx, { taskId: task.id }),
		agentNames: listAgentNames(ctx)
	};
};
