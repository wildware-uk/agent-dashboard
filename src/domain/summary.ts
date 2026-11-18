/**
 * The whole dashboard in one small read, for a phone's widget, Siri and Live
 * Activity: who is online, what is waiting on the owner, how much work is open.
 *
 * One function feeds both `GET /api/summary` and the Live Activity sender, so a
 * widget and the lock screen can never disagree about how many are waiting.
 */
import {
	countWorkByStatus,
	findAgentById,
	findProjectById,
	listRepliesTo,
	listWork,
	type RequestKind,
	type WorkRow
} from '$db';
import type { DomainContext } from './context';
import { markdownToPlainText } from './plain-text';
import { listProjects } from './projects';
import { listPendingRequests } from './requests';
import { listLiveAgents } from './sessions';

export type SummaryRequest = {
	id: string;
	agentId: string;
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
	/** What is in progress right now, most recently started first ({@link WORKING_MAX} at most). */
	working: WorkingCard[];
};

/**
 * One card in progress, as the lock screen shows it: who, doing what, since when.
 *
 * `since` is fixed (when it went in progress), not a running time, so the
 * state only changes when something real does; the phone counts up itself.
 */
export type WorkingCard = {
	agentId: string | null;
	agent: string;
	task: string;
	/** Seconds since 1970 when it went in progress. */
	since: number;
};

/** How many in-progress cards the summary and the Live Activity carry. */
export const WORKING_MAX = 3;

/** Lengths the lock screen has room for, in UTF-16 units. */
const NAME_MAX = 40;
const TASK_MAX = 60;
const OPTION_MAX = 40;
const OPTIONS_MAX = 4;

/**
 * [text] in at most [max] UTF-16 units: whole, or cut, trimmed and ended with
 * an ellipsis. Never splits a surrogate pair.
 */
export function cut(text: string, max: number): string {
	if (text.length <= max) return text;
	let end = max - 1;
	const last = text.charCodeAt(end - 1);
	if (last >= 0xd800 && last <= 0xdbff) end -= 1;
	return `${text.slice(0, end).trimEnd()}…`;
}

/** The first line of some markdown, as plain text with its whitespace collapsed. */
function firstLine(markdown: string): string {
	const plain = markdownToPlainText(markdown).split('\n')[0] ?? '';
	return plain.replace(/\s+/g, ' ').trim();
}

function agentOf(author: string): string | null {
	return author.startsWith('agent:') ? author.slice('agent:'.length) : null;
}

/**
 * Who is doing a card: the agent that posted it, or for a card the owner wrote,
 * the agent that answered it last.
 */
function workerOf(ctx: DomainContext, row: WorkRow): string | null {
	const author = agentOf(row.author);
	if (author || row.kind !== 'message') return author;
	const replies = listRepliesTo(ctx.db, row.id);
	for (let i = replies.length - 1; i >= 0; i -= 1) {
		const agent = agentOf(replies[i].author);
		if (agent) return agent;
	}
	return null;
}

function workingCards(ctx: DomainContext, projectIds: string[]): WorkingCard[] {
	if (projectIds.length === 0) return [];
	return listWork(ctx.db, { projectIds, statuses: ['in_progress'], limit: WORKING_MAX }).map(
		(row): WorkingCard => {
			const agentId = workerOf(ctx, row);
			const name = agentId ? (findAgentById(ctx.db, agentId)?.name ?? 'An agent') : 'An agent';
			const title = row.kind === 'update' && row.title?.trim() ? firstLine(row.title) : '';
			return {
				agentId,
				agent: cut(name, NAME_MAX),
				task: cut(title || firstLine(row.body), TASK_MAX),
				since: Math.floor((row.statusAt ?? row.createdAt) / 1000)
			};
		}
	);
}

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
			agentId: request.agentId,
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
			.map((project) => ({ slug: project.slug, name: project.name })),
		working: workingCards(
			ctx,
			active.map((project) => project.id)
		)
	};
}

/**
 * What the Live Activity shows. Keys are what the app decodes, in this order:
 * the first seven never change, and every later one is always present, `null`
 * when there is nothing. The phone's own `sentAnswer` is never sent.
 */
export type LiveActivityState = {
	online: number;
	waiting: number;
	inProgress: number;
	topAgent: string | null;
	topQuestion: string | null;
	topRequestId: string | null;
	topKind: RequestKind | null;
	topAgentId: string | null;
	/** The top request's project name, cut to fit. */
	topProject: string | null;
	/** When the top request times out, in seconds since 1970; the phone counts down. */
	topExpiresAt: number | null;
	/** Buttons the lock screen can answer with, only when every one fits uncut. */
	topOptions: string[] | null;
	topDefault: string | null;
	working: WorkingCard[] | null;
};

/**
 * Options the lock screen can offer as they are. The phone answers with the
 * text it shows, so an option is never cut: one that would not fit means none.
 */
function lockScreenOptions(top: SummaryRequest): string[] | null {
	const options = top.options;
	if (top.kind !== 'buttons' && top.kind !== 'choice') return null;
	if (!options || options.length < 1 || options.length > OPTIONS_MAX) return null;
	return options.every((option) => option.length <= OPTION_MAX) ? options : null;
}

export function liveActivityState(summary: OwnerSummary): LiveActivityState {
	const top = summary.requests[0];
	return {
		online: summary.onlineAgents.length,
		waiting: summary.requests.length,
		inProgress: summary.work.inProgress,
		topAgent: top?.agentName ?? null,
		topQuestion: top?.question ?? null,
		topRequestId: top?.id ?? null,
		topKind: top?.kind ?? null,
		topAgentId: top?.agentId ?? null,
		topProject: top?.projectName ? cut(top.projectName, NAME_MAX) : null,
		topExpiresAt: top ? Math.floor(Date.parse(top.expiresAt) / 1000) : null,
		topOptions: top ? lockScreenOptions(top) : null,
		topDefault: top?.default != null && top.default.length <= OPTION_MAX ? top.default : null,
		working: summary.working.length > 0 ? summary.working : null
	};
}
