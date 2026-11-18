/**
 * The whole dashboard in one small read, for a phone's widget, Siri and Live
 * Activity: who is online, what is waiting on the owner, how much work is open.
 *
 * One function feeds both `GET /api/summary` and the Live Activity sender, so a
 * widget and the lock screen can never disagree about how many are waiting.
 */
import { countWorkByStatus, findAgentById, findProjectById, type RequestKind } from '$db';
import type { DomainContext } from './context';
import { listProjects } from './projects';
import { listPendingRequests } from './requests';
import { listLiveAgents } from './sessions';

export type SummaryRequest = {
	id: string;
	agentName: string;
	projectSlug: string | null;
	projectName: string | null;
	question: string;
	/** The longer explanation under the question. */
	detail: string | null;
	/** What the control starts filled with, if the agent gave one. */
	default: string | null;
	kind: RequestKind;
	options: string[] | null;
	expiresAt: string;
};

export type OwnerSummary = {
	at: string;
	onlineAgents: { agentId: string; name: string; host: string | null; cwd: string | null }[];
	/** Pending only, longest-waiting first. */
	requests: SummaryRequest[];
	/** Open work across every active project. */
	work: { todo: number; inProgress: number; blocked: number };
	/** Active projects, pinned first, then by name. */
	projects: { slug: string; name: string }[];
};

export function ownerSummary(ctx: DomainContext): OwnerSummary {
	const now = ctx.now();
	const active = listProjects(ctx, { status: 'active' });
	const counts = countWorkByStatus(
		ctx.db,
		active.map((project) => project.id)
	);

	const requests = listPendingRequests(ctx).map((request): SummaryRequest => {
		const project = request.projectId ? findProjectById(ctx.db, request.projectId) : undefined;
		return {
			id: request.id,
			agentName: findAgentById(ctx.db, request.agentId)?.name ?? 'An agent',
			projectSlug: project?.slug ?? null,
			projectName: project?.name ?? null,
			question: request.question,
			detail: request.detail,
			default: request.config?.default ?? null,
			kind: request.kind,
			options: request.options && request.options.length > 0 ? request.options : null,
			expiresAt: new Date(request.expiresAt).toISOString()
		};
	});

	return {
		at: new Date(now).toISOString(),
		onlineAgents: listLiveAgents(ctx, now).map((agent) => ({
			agentId: agent.agentId,
			name: agent.name,
			host: agent.host,
			cwd: agent.cwd
		})),
		requests,
		work: { todo: counts.todo, inProgress: counts.in_progress, blocked: counts.blocked },
		projects: [...active]
			.sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.name.localeCompare(b.name))
			.map((project) => ({ slug: project.slug, name: project.name }))
	};
}

/** What the Live Activity shows. Keys are what the app decodes. */
export type LiveActivityState = {
	online: number;
	waiting: number;
	inProgress: number;
	topAgent: string | null;
	topQuestion: string | null;
	topRequestId: string | null;
	topKind: RequestKind | null;
};

export function liveActivityState(summary: OwnerSummary): LiveActivityState {
	const top = summary.requests[0];
	return {
		online: summary.onlineAgents.length,
		waiting: summary.requests.length,
		inProgress: summary.work.inProgress,
		topAgent: top?.agentName ?? null,
		topQuestion: top?.question ?? null,
		topRequestId: top?.id ?? null,
		topKind: top?.kind ?? null
	};
}
