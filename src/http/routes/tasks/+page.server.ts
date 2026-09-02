/**
 * Every task, as a page rather than a panel (design §7).
 *
 * The rail's task list is a corner of the dashboard and it is `xl:block` — below
 * 1280px it is not on screen at all, behind a drawer nobody opens. Tasks are the
 * long-running half of this product: what is being worked on, as opposed to what
 * happened. That deserves somewhere to go.
 *
 * Ordered by state rather than by time, because the question a tasks page
 * answers is "what is outstanding": in progress first, then waiting to be
 * picked up, then the finished tail — which is deliberately last and deliberately
 * allowed to be long, because nothing about it is urgent.
 */
import { acknowledgementsFor, context, findProject, listAgentNames, listTasks } from '$domain';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ url }) => {
	const ctx = context();
	const slug = url.searchParams.get('project');
	const project = slug ? (findProject(ctx, slug) ?? null) : null;

	// One read of everything, then grouped here. The alternative is four queries
	// answering four questions about the same short list.
	const tasks = listTasks(ctx, { project: project?.slug, limit: 200 });

	return {
		project,
		agentNames: listAgentNames(ctx),
		tasks,
		// What agents have said about them (migration 013). Only the `done` ticks
		// are rendered here — see the page's own note on why a static page must
		// not animate a "thinking".
		acks: acknowledgementsFor(ctx, { taskIds: tasks.map((task) => task.id) })
	};
};
