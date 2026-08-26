/**
 * Owner requests: an agent stops and asks its owner something (design §5, §7).
 *
 * Five kinds, one mechanism. `text` wants a string, `confirm` a yes or no,
 * `buttons` one action out of several, `choice` one option from a list, and
 * `multi_choice` any number of them. Permission is one shape of asking, not the
 * whole of it, so there is one table, one wait, and one event vocabulary
 * covering all five.
 *
 * ## The wait is durable because it is not a socket
 *
 * Holding an HTTP request until a human clicks does not work: MCP clients time
 * out tool calls long before a human necessarily answers, and a dropped
 * connection loses the wait outright. So every kind is a **bounded long-poll
 * with durable resume**:
 *
 * 1. {@link requestInput} writes a `pending` row and publishes `request.created`.
 * 2. It parks on the event bus for at most {@link DEFAULT_HOLD_MS} — under the 60
 *    second tool timeout common to MCP clients — using the park-until-event
 *    primitive in `$events` rather than a second one of its own.
 * 3. Answered inside the hold, it returns `answered` with the typed value.
 * 4. Still pending, it returns `pending` with the id, and the agent calls
 *    {@link awaitRequest} again. The tool description is what makes that loop
 *    happen (`src/mcp/tools/request-input.ts`).
 *
 * Nothing about the wait lives in the waiter. The row is the state, so a
 * *different process* that has never seen the request can call
 * {@link awaitRequest} with the id and resume it, and any number of waiters can
 * hold the same request at once: they all unblock on the one `request.answered`
 * event, then each re-reads the row.
 *
 * That re-read is deliberate and is the reason the event payload is thin. The
 * row is the authority on what the owner said; an answer copied onto the bus
 * would be a second copy that a replayed or out-of-order frame could disagree
 * with. Every path here — answered, timed out, dismissed — ends in the same
 * "read the row, then say what it means".
 *
 * ## The server validates every answer against the request that asked for it
 *
 * A `choice` answer must be one of the options that were offered, a
 * `multi_choice` must respect `min` and `max`, a `text` answer must respect its
 * length bounds. The agent is about to *act* on the value, and the browser is
 * not a trustworthy client: {@link validateAnswer} is the one gate, it runs
 * inside {@link answerRequest}, and the HTTP endpoint has no way round it.
 *
 * ## States
 *
 * The domain's vocabulary is `pending`, `answered`, `timeout`, `cancelled`. The
 * table keeps migration 001's `approved`/`rejected` pair for the settled case —
 * `confirm` writes both, every other kind writes `approved` — because migrations
 * are append-only and other slices read that column. {@link toRequest} is the one
 * place the two vocabularies meet.
 */
import {
	countPendingApprovals,
	decideApproval,
	expireApprovals,
	findApprovalById,
	findUpdateById,
	insertApproval,
	listApprovals,
	type Approval,
	type RequestAnswer,
	type RequestConfig,
	type RequestKind,
	type RequestValue
} from '$db';
import { context as sharedContext, type DomainContext } from './context';
import { conflict, invalid, notFound } from './errors';
import { resolveProject } from './projects';
import { optionalText, requiredText } from './text';

/** The five kinds, in the order design §5 tabulates them. */
export const REQUEST_KINDS = ['text', 'confirm', 'buttons', 'choice', 'multi_choice'] as const;

/** The kinds that offer the owner a list to pick from. */
const LISTED: readonly RequestKind[] = ['buttons', 'choice', 'multi_choice'];

/** One line the owner reads at the top of a banner. Not a report. */
export const QUESTION_MAX_LENGTH = 500;
/** The paragraph under it: what the agent found, why it is asking. */
export const DETAIL_MAX_LENGTH = 4_000;
/** A button label or a list row. Long enough for a filename, short enough to hit. */
export const OPTION_MAX_LENGTH = 200;
/** More than this is a list the owner cannot read on a phone. */
export const OPTIONS_MAX = 25;
/** The default ceiling on a `text` answer: a commit message, not a document. */
export const TEXT_ANSWER_MAX_LENGTH = 10_000;

/** One hour, as design §5 specifies. */
export const DEFAULT_TIMEOUT_S = 3_600;
/** A request that expires sooner than this cannot be answered by a human in time. */
export const MIN_TIMEOUT_S = 5;
/** A day. Past this, the agent has stopped being a thing anybody is waiting on. */
export const MAX_TIMEOUT_S = 24 * 60 * 60;

/**
 * How long one call parks before handing back `pending` (design §5).
 *
 * 55 seconds, deliberately under the 60 second tool timeout common to MCP
 * clients: the call has to return *before* the client gives up on it, or the
 * durable resume never gets a chance to happen.
 */
export const DEFAULT_HOLD_MS = 55_000;

/** How long an agent should wait before calling `await_request` again. */
export const POLL_AFTER_MS = 1_000;

/**
 * How many outstanding requests the banner is handed at once.
 *
 * Far above the number of agents one deployment runs (§1 sizes this at tens), so
 * in practice it is "all of them" — but a browser must not be handed an unbounded
 * list, and a number stated here beats one inherited from a repository default.
 */
export const PENDING_REQUEST_LIMIT = 200;

/** How often the sweeper looks for requests whose deadline has passed. */
export const REQUEST_SWEEP_INTERVAL_MS = 30_000;

/** The states the domain speaks (design §5). The table's are narrower; see above. */
export type RequestState = 'pending' | 'answered' | 'timeout' | 'cancelled';

export type { RequestAnswer, RequestConfig, RequestKind, RequestValue };

/** One owner request, as every caller outside `$db` sees it. */
export type OwnerRequest = {
	id: string;
	/** Ordering key. The banner queues on it: longest-blocked agent first. */
	seq: number;
	agentId: string;
	projectId: string | null;
	updateId: string | null;
	kind: RequestKind;
	question: string;
	detail: string | null;
	/** What the owner may pick from, for the three listed kinds. */
	options: string[] | null;
	/** Kind-specific knobs: placeholder, multiline, default, min, max. */
	config: RequestConfig | null;
	state: RequestState;
	expiresAt: number;
	/** When it settled, however it settled. */
	answeredAt: number | null;
	/** The typed answer, once there is one. */
	answer: RequestAnswer | null;
};

/** What an agent gets back from a wait, whichever tool it called. */
export type RequestResult =
	| { state: 'answered'; request: OwnerRequest; response: RequestAnswer; answeredAt: number }
	| { state: 'pending'; request: OwnerRequest; pollAfterMs: number }
	| { state: 'timeout'; request: OwnerRequest }
	| { state: 'cancelled'; request: OwnerRequest };

export type CreateRequestInput = {
	/** The caller, resolved from its bearer token — never from an argument (§5). */
	agentId: string;
	kind: RequestKind;
	question: string;
	detail?: string | null;
	/** Required for `buttons`, `choice` and `multi_choice`; refused for the rest. */
	options?: readonly string[] | null;
	/** `text` only: the greyed-out hint in the empty box. */
	placeholder?: string | null;
	/** `text` only: give the owner a textarea rather than one line. */
	multiline?: boolean;
	/** Pre-fills the control. An option for the listed kinds; text for `text`. */
	default?: string | null;
	/** `multi_choice`: fewest selections. `text`: shortest answer. */
	min?: number;
	/** `multi_choice`: most selections. `text`: longest answer. */
	max?: number;
	/** A project slug or id, so the banner can say what this is about. */
	project?: string | null;
	/** The update this follows from. Supplies the project when that is omitted. */
	update?: string | null;
	/** Seconds until the request times out. Defaults to {@link DEFAULT_TIMEOUT_S}. */
	timeoutS?: number;
};

export type RequestWaitOptions = {
	/** Defaults to {@link DEFAULT_HOLD_MS}. The MCP layer passes `HOLD_S`. */
	holdMs?: number;
	/** Ends the wait early, e.g. when the requesting connection goes away. */
	signal?: AbortSignal;
};

/**
 * Ask the owner something, then wait for as long as one call may.
 *
 * @returns `answered` when the owner answered inside the hold, `pending` with
 *   the id to resume on when they did not, and `timeout` or `cancelled` when the
 *   request ended without an answer.
 * @throws {DomainError} `invalid_argument` for a request that contradicts itself
 *   — a `choice` with no options, a `min` above its `max`, a placeholder on a
 *   confirm; `not_found` for an unknown project or update.
 */
export async function requestInput(
	ctx: DomainContext,
	input: CreateRequestInput,
	options: RequestWaitOptions = {}
): Promise<RequestResult> {
	const { request, seq } = createRequest(ctx, input);
	return hold(ctx, request, seq, options);
}

/**
 * Resume a wait on a request this process may never have seen.
 *
 * The durability guarantee in one function: nothing is looked up in memory, so
 * an agent that crashed mid-wait, or a second process entirely, resumes by id.
 *
 * @throws {DomainError} `not_found` for an unknown id, `invalid_argument` when
 *   the request belongs to another agent — identity comes from the token, so one
 *   agent may not read what its owner told another (design §5).
 */
export async function awaitRequest(
	ctx: DomainContext,
	input: { requestId: string; agentId: string },
	options: RequestWaitOptions = {}
): Promise<RequestResult> {
	// Read the cursor *before* the row. A request answered in the gap publishes
	// an event with a seq above this one, so the park's replay scan finds it
	// rather than waiting for an event that has already been and gone.
	const seq = ctx.bus.lastSeq;
	const request = ownRequest(ctx, input.requestId, input.agentId);
	return hold(ctx, request, seq, options);
}

/**
 * Write the row and announce it. Exported for the UI's own tests and for callers
 * that want the prompt on screen without parking on it.
 */
export function createRequest(
	ctx: DomainContext,
	input: CreateRequestInput
): { request: OwnerRequest; seq: number } {
	const kind = assertKind(input.kind);
	const question = requiredText(input.question, 'question', QUESTION_MAX_LENGTH);
	const detail = optionalText(input.detail, 'detail', DETAIL_MAX_LENGTH);
	const options = assertOptions(kind, input.options);
	const config = assertConfig(kind, options, input);
	const { projectId, updateId } = anchor(ctx, input);
	const timeoutS = assertTimeout(input.timeoutS);

	const row = insertApproval(ctx.db, {
		agentId: input.agentId,
		projectId,
		updateId,
		kind,
		question,
		detail,
		options,
		config,
		expiresAt: ctx.now() + timeoutS * 1_000
	});

	const request = toRequest(row);
	const event = ctx.bus.publish('request.created', {
		requestId: request.id,
		agentId: request.agentId,
		projectId: request.projectId,
		kind: request.kind
	});

	return { request, seq: event.seq };
}

/**
 * The owner's answer, checked against the request that asked for it.
 *
 * This is the only way a row leaves `pending` with an answer on it, so the
 * checks in {@link validateAnswer} cannot be routed around by a browser, a curl,
 * or a second endpoint added later.
 *
 * @throws {DomainError} `not_found` for an unknown id; `invalid_argument` for an
 *   answer the request does not allow; `conflict` when it is no longer pending —
 *   already answered, dismissed, or timed out while the owner was typing.
 */
export function answerRequest(
	ctx: DomainContext,
	input: { requestId: string; value: unknown }
): OwnerRequest {
	const request = expireIfDue(ctx, mustFind(ctx, input.requestId));
	if (request.state !== 'pending') throw settledAlready(request);

	const answer = validateAnswer(request, input.value);
	const row = decideApproval(ctx.db, request.id, {
		// `confirm` is the one kind the table's own vocabulary already describes,
		// so it keeps writing `approved`/`rejected`. Everything else is `approved`
		// meaning "settled with an answer", and `answer` carries what that was.
		state: answer.kind === 'confirm' && answer.value === false ? 'rejected' : 'approved',
		value: scalarOf(answer),
		answer,
		at: ctx.now()
	});
	// Lost a race with a dismiss or the sweeper between the read and the write.
	if (!row) throw settledAlready(mustFind(ctx, request.id));

	return settle(ctx, row, 'answered');
}

/**
 * The owner dismisses the prompt: the agent is told `cancelled` and stops
 * waiting (design §5). Not a rejection — `confirm` has one of those, and it is
 * an answer.
 */
export function cancelRequest(ctx: DomainContext, requestId: string): OwnerRequest {
	const request = expireIfDue(ctx, mustFind(ctx, requestId));
	if (request.state !== 'pending') throw settledAlready(request);

	const row = decideApproval(ctx.db, requestId, { state: 'cancelled', at: ctx.now() });
	if (!row) throw settledAlready(mustFind(ctx, requestId));

	return settle(ctx, row, 'cancelled');
}

/** What is waiting on the owner right now, longest-blocked first (design §7). */
export function listPendingRequests(ctx: DomainContext): OwnerRequest[] {
	const now = ctx.now();
	// `oldestFirst` is what makes the cap safe: newest-first plus a limit hid the
	// agents blocked longest, which are the ones this list exists to surface.
	return listApprovals(ctx.db, {
		state: 'pending',
		limit: PENDING_REQUEST_LIMIT,
		oldestFirst: true
	})
		.map(toRequest)
		.filter((request) => request.expiresAt > now)
		.sort((a, b) => a.seq - b.seq);
}

/** One request by id, for the banner and for a route that needs to name it. */
export function findRequest(ctx: DomainContext, requestId: string): OwnerRequest | null {
	const row = findApprovalById(ctx.db, requestId);
	return row ? toRequest(row) : null;
}

/**
 * How many of this agent's requests are still waiting on the owner.
 *
 * The heartbeat's `pending_approvals` (design §5). A request that has expired but
 * not yet been swept can be counted for up to one sweep interval; the agent's own
 * wait reports the timeout immediately, so the count is a nudge rather than the
 * authority.
 */
export function countPendingRequests(ctx: DomainContext, agentId: string): number {
	return countPendingApprovals(ctx.db, agentId);
}

/**
 * Flip every request whose deadline has passed, and wake whoever was parked on
 * it.
 *
 * One event per row, so a waiter that is holding the bus rather than the row
 * still learns immediately.
 */
export function expireRequests(ctx: DomainContext): OwnerRequest[] {
	const now = ctx.now();
	return expireApprovals(ctx.db, { now, at: now }).map((row) => settle(ctx, row, 'timeout'));
}

export type RequestSweeperOptions = {
	context?: () => DomainContext;
	intervalMs?: number;
	onError?: (error: unknown) => void;
};

/**
 * Run {@link expireRequests} on an interval.
 *
 * A parked waiter times itself out at its own deadline, so this is not what
 * makes the agent's answer correct — it is what stops a prompt nobody is holding
 * from sitting in the owner's banner forever.
 *
 * @returns a function that stops it. Idempotent.
 */
export function startRequestSweeper(options: RequestSweeperOptions = {}): () => void {
	const {
		context: getContext = sharedContext,
		intervalMs = REQUEST_SWEEP_INTERVAL_MS,
		onError = (error: unknown) => console.error('request sweep failed', error)
	} = options;

	const timer = setInterval(() => {
		try {
			expireRequests(getContext());
		} catch (error) {
			onError(error);
		}
	}, intervalMs);
	timer.unref?.();

	return () => clearInterval(timer);
}

/**
 * Check an answer against the request that asked for it.
 *
 * Exported because it is the security boundary of this slice and deserves to be
 * tested directly, not only through an endpoint.
 *
 * @returns the answer, typed by kind: a string, a boolean, or a list of strings.
 * @throws {DomainError} `invalid_argument`, naming what was wrong with it.
 */
export function validateAnswer(request: OwnerRequest, value: unknown): RequestAnswer {
	const { kind } = request;
	const config = request.config ?? {};
	const options = request.options ?? [];

	if (kind === 'confirm') {
		if (typeof value !== 'boolean') throw invalid('a confirm is answered true or false');
		return { kind, value };
	}

	if (kind === 'text') {
		if (typeof value !== 'string') throw invalid('a text request is answered with a string');
		const text = value.trim();
		const min = config.min ?? 1;
		const max = config.max ?? TEXT_ANSWER_MAX_LENGTH;
		if (text.length < min) throw invalid(`the answer must be at least ${min} characters`);
		if (text.length > max) throw invalid(`the answer must be at most ${max} characters`);
		return { kind, value: text };
	}

	if (kind === 'multi_choice') {
		if (!Array.isArray(value)) throw invalid('a multi_choice is answered with a list of options');
		const chosen = value as unknown[];
		for (const item of chosen) {
			if (typeof item !== 'string' || !options.includes(item)) {
				throw invalid(`${JSON.stringify(item)} is not one of the options offered`);
			}
		}
		const picked = chosen as string[];
		if (new Set(picked).size !== picked.length) throw invalid('an option was chosen twice');
		const min = config.min ?? 0;
		const max = config.max ?? options.length;
		if (picked.length < min) throw invalid(`choose at least ${min}`);
		if (picked.length > max) throw invalid(`choose at most ${max}`);
		return { kind, value: picked };
	}

	// `buttons` and `choice`: one of the offered strings, and nothing else.
	if (typeof value !== 'string' || !options.includes(value)) {
		throw invalid(`${JSON.stringify(value)} is not one of the options offered`);
	}
	return { kind, value };
}

/**
 * The bounded wait itself.
 *
 * One park, not a loop: `request.answered` is published exactly once per
 * request, when the row has already settled, so a matching event always means
 * "go and read it". The wait is bounded by whichever comes first, the hold or
 * the request's own deadline, which is what lets an agent learn about a short
 * `timeout_s` without waiting out the full hold to hear it.
 */
async function hold(
	ctx: DomainContext,
	request: OwnerRequest,
	since: number,
	options: RequestWaitOptions
): Promise<RequestResult> {
	const current = expireIfDue(ctx, request);
	if (current.state !== 'pending') return resultFor(current);

	const holdMs = options.holdMs ?? DEFAULT_HOLD_MS;
	const timeoutMs = Math.max(0, Math.min(holdMs, current.expiresAt - ctx.now()));

	await ctx.bus.waitFor({
		types: ['request.answered'],
		where: (event) => event.payload.requestId === current.id,
		since,
		timeoutMs,
		signal: options.signal
	});

	// The row, not the event, is the authority — and it is also what a waiter in
	// a process that missed the event entirely would read.
	const settled = expireIfDue(ctx, mustFind(ctx, current.id));
	if (settled.state !== 'pending') return resultFor(settled);

	return { state: 'pending', request: settled, pollAfterMs: POLL_AFTER_MS };
}

function resultFor(request: OwnerRequest): RequestResult {
	if (request.state === 'answered' && request.answer) {
		return {
			state: 'answered',
			request,
			response: request.answer,
			answeredAt: request.answeredAt ?? 0
		};
	}
	if (request.state === 'timeout') return { state: 'timeout', request };
	if (request.state === 'cancelled') return { state: 'cancelled', request };
	return { state: 'pending', request, pollAfterMs: POLL_AFTER_MS };
}

/** Publish the one settling event, and hand back the request it settled. */
function settle(ctx: DomainContext, row: Approval, state: 'answered' | 'timeout' | 'cancelled') {
	const request = toRequest(row);
	ctx.bus.publish('request.answered', {
		requestId: request.id,
		agentId: request.agentId,
		state,
		settledAt: new Date(request.answeredAt ?? ctx.now()).toISOString()
	});
	return request;
}

/**
 * Time out a request whose deadline has passed, right where it is read.
 *
 * The sweeper does this on an interval, but a waiter must not be told `pending`
 * about a request that expired while it was parked, so every read path goes
 * through here first.
 */
function expireIfDue(ctx: DomainContext, request: OwnerRequest): OwnerRequest {
	if (request.state !== 'pending' || ctx.now() < request.expiresAt) return request;

	const row = decideApproval(ctx.db, request.id, { state: 'timeout', at: ctx.now() });
	// Somebody else settled it first; whatever they wrote is the truth.
	if (!row) return toRequest(findApprovalById(ctx.db, request.id)!);
	return settle(ctx, row, 'timeout');
}

function mustFind(ctx: DomainContext, requestId: string): OwnerRequest {
	const row = findApprovalById(ctx.db, requestId);
	if (!row) throw notFound(`no such request: ${requestId}`);
	return toRequest(row);
}

/**
 * The request, if it is this agent's.
 *
 * The same rule every session-taking tool keeps: an id guessed or copied from
 * another agent must not let one agent read what the owner told another.
 */
function ownRequest(ctx: DomainContext, requestId: string, agentId: string): OwnerRequest {
	const request = mustFind(ctx, requestId);
	if (request.agentId !== agentId) throw invalid('request belongs to another agent');
	return request;
}

function settledAlready(request: OwnerRequest) {
	const said = {
		answered: 'has already been answered',
		timeout: 'timed out',
		cancelled: 'was dismissed',
		pending: 'is still pending'
	}[request.state];
	return conflict(`request ${request.id} ${said}`);
}

/** The scalar `decided_value` keeps, where the answer is one. */
function scalarOf(answer: RequestAnswer): string | null {
	if (typeof answer.value === 'boolean') return answer.value ? 'true' : 'false';
	return Array.isArray(answer.value) ? null : answer.value;
}

/** The row's two settled states become one, and the JSON columns are decoded. */
function toRequest(row: Approval): OwnerRequest {
	const state: RequestState =
		row.state === 'pending' || row.state === 'timeout' || row.state === 'cancelled'
			? row.state
			: 'answered';

	return {
		id: row.id,
		seq: row.seq,
		agentId: row.agentId,
		projectId: row.projectId,
		updateId: row.updateId,
		kind: row.kind,
		question: row.question,
		detail: row.detail,
		options: row.options,
		config: row.config,
		state,
		expiresAt: row.expiresAt,
		answeredAt: row.decidedAt,
		answer: answerOf(row)
	};
}

/**
 * The structured answer, reconstructed for a row that predates it.
 *
 * Migration 002 added the `answer` column, so a row settled before it has only
 * `state` and `decided_value` — which is exactly a `confirm`'s answer, because
 * before this slice every row was an approval.
 */
function answerOf(row: Approval): RequestAnswer | null {
	if (row.answer) return row.answer;
	if (row.state !== 'approved' && row.state !== 'rejected') return null;
	return { kind: 'confirm', value: row.state === 'approved' };
}

function assertKind(kind: RequestKind): RequestKind {
	if (!REQUEST_KINDS.includes(kind)) {
		throw invalid(`kind must be one of ${REQUEST_KINDS.join(', ')}`);
	}
	return kind;
}

/**
 * The options, checked against the kind that offered them.
 *
 * A `choice` with no options is a prompt the owner cannot answer, and a
 * `confirm` with options is two controls disagreeing about what the question is.
 * Both are refused at the ask rather than rendered as something surprising.
 */
function assertOptions(kind: RequestKind, options: readonly string[] | null | undefined) {
	if (!LISTED.includes(kind)) {
		if (options && options.length > 0) throw invalid(`a ${kind} request takes no options`);
		return null;
	}

	const list = (options ?? []).map((option, index) =>
		requiredText(option, `options[${index}]`, OPTION_MAX_LENGTH)
	);
	if (list.length === 0) throw invalid(`a ${kind} request needs at least one option`);
	if (list.length > OPTIONS_MAX) throw invalid(`at most ${OPTIONS_MAX} options`);
	if (new Set(list).size !== list.length) throw invalid('options must be distinct');
	return list;
}

/** The kind-specific knobs, each refused on a kind that has no use for it. */
function assertConfig(
	kind: RequestKind,
	options: string[] | null,
	input: CreateRequestInput
): RequestConfig | null {
	const config: RequestConfig = {};

	const placeholder = optionalText(input.placeholder, 'placeholder', OPTION_MAX_LENGTH);
	if (placeholder !== null) {
		if (kind !== 'text') throw invalid('placeholder is for a text request');
		config.placeholder = placeholder;
	}

	if (input.multiline !== undefined && input.multiline) {
		if (kind !== 'text') throw invalid('multiline is for a text request');
		config.multiline = true;
	}

	const fallback = optionalText(input.default, 'default', TEXT_ANSWER_MAX_LENGTH);
	if (fallback !== null) {
		if (kind === 'multi_choice') throw invalid('a multi_choice takes no default');
		if (kind === 'confirm' && fallback !== 'true' && fallback !== 'false') {
			throw invalid('the default for a confirm is "true" or "false"');
		}
		if (options && !options.includes(fallback)) {
			throw invalid('the default must be one of the options');
		}
		config.default = fallback;
	}

	if (input.min !== undefined || input.max !== undefined) {
		if (kind !== 'text' && kind !== 'multi_choice') {
			throw invalid(`min and max are for a text or multi_choice request`);
		}
		const ceiling = kind === 'text' ? TEXT_ANSWER_MAX_LENGTH : (options?.length ?? 0);
		const min = bound(input.min, 'min', ceiling);
		const max = bound(input.max, 'max', ceiling);
		if (min !== null && max !== null && min > max) throw invalid('min must not exceed max');
		if (min !== null) config.min = min;
		if (max !== null) config.max = max;
	}

	return Object.keys(config).length === 0 ? null : config;
}

function bound(value: number | undefined, field: string, ceiling: number): number | null {
	if (value === undefined) return null;
	if (!Number.isInteger(value) || value < 0) throw invalid(`${field} must be a whole number`);
	if (value > ceiling) throw invalid(`${field} must be at most ${ceiling}`);
	return value;
}

function assertTimeout(timeoutS: number | undefined): number {
	if (timeoutS === undefined) return DEFAULT_TIMEOUT_S;
	if (!Number.isInteger(timeoutS) || timeoutS < MIN_TIMEOUT_S || timeoutS > MAX_TIMEOUT_S) {
		throw invalid(
			`timeout_s must be a whole number of seconds between ${MIN_TIMEOUT_S} and ${MAX_TIMEOUT_S}`
		);
	}
	return timeoutS;
}

/**
 * What the request is about.
 *
 * An update supplies its own project, so the two cannot disagree: naming both
 * and contradicting yourself is refused rather than reconciled, exactly as a
 * message's anchor is (`./messages.ts`).
 */
function anchor(ctx: DomainContext, input: CreateRequestInput) {
	const named = input.project?.trim() ? resolveProject(ctx, input.project) : null;

	if (!input.update?.trim()) return { projectId: named?.id ?? null, updateId: null };

	const update = findUpdateById(ctx.db, input.update.trim());
	if (!update) throw notFound(`no such update: ${input.update.trim()}`);
	if (named && named.id !== update.projectId) {
		throw invalid('the update named belongs to a different project');
	}
	return { projectId: update.projectId, updateId: update.id };
}
