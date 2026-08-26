<script lang="ts">
	/**
	 * The task panel (design §7): a plain per-project list across todo, claimed
	 * and done. No drag and drop — the design says so, and it is the right call
	 * for a surface that is 17rem wide on the desktop rail and a thumb's width on
	 * a phone.
	 *
	 * Two rules shape everything here.
	 *
	 * **The owner creates and steers; the agent claims and completes.** So this
	 * panel offers exactly two writes — put work on a project, and reassign or
	 * withdraw it — and no button that would mark work done. Claiming is an
	 * agent's `claim_task` over MCP (design §5), and a browser that could fake it
	 * would be a browser that lies about who did the work.
	 *
	 * **Nothing is rendered optimistically.** A control awaits its call, the
	 * server publishes `task.created` or `task.updated`, and the change arrives
	 * back through the store on the stream — the same route it would take if an
	 * agent, or a second tab, had done it. That is what makes "a claim appears
	 * with no reload" the same code path as "the owner's own click appears".
	 *
	 * The agent names come from the shell, which already holds every agent this
	 * deployment knows (the timeline snapshot) plus everyone seen online since the
	 * page loaded (presence). A ULID on a task row would be as unreadable here as
	 * it was on a card: every one of them begins `01` until 2039.
	 */
	import { onMount } from 'svelte';
	import { actionMessage, type OwnerActions } from './actions';
	import { Tasks } from './tasks.svelte';
	import Thread from './Thread.svelte';
	import type { ThreadSource } from './threads.svelte';
	import type { ProjectView, TaskView } from './types';

	let {
		/** The live list. Owned by whoever mounts this; a spec injects its own. */
		tasks = new Tasks(),
		/** The selected project's slug, or `null` on the all-projects view. */
		project = null,
		/** Every project, for the create form when no single one is on screen. */
		projects = [],
		/** Agent id to display name, from the shell. */
		agentNames = {},
		actions,
		/**
		 * The live message store, so a task carries its conversation.
		 *
		 * A task is the other thing an agent and its owner talk about — "why is
		 * this blocked", "use the other branch" — and #14 built the plumbing for it
		 * (`postMessage` takes a task, the store exposes `forTask`) while the panel
		 * that needed it belonged to #11. Optional so a spec can mount the panel
		 * without one.
		 */
		threads = undefined
	}: {
		tasks?: Tasks;
		project?: string | null;
		projects?: ProjectView[];
		agentNames?: Record<string, string>;
		actions: OwnerActions;
		threads?: ThreadSource;
	} = $props();

	onMount(() => {
		tasks.start();
		return () => tasks.stop();
	});

	/** The assignee dropdowns, in a stable order rather than object order. */
	const agents = $derived(
		Object.entries(agentNames)
			.map(([id, name]) => ({ id, name }))
			.sort((left, right) => left.name.localeCompare(right.name))
	);

	const groups = $derived([
		{ key: 'todo', label: 'To do', items: tasks.todo },
		{ key: 'claimed', label: 'Claimed', items: tasks.claimed },
		{ key: 'done', label: 'Done', items: tasks.done }
	]);

	let open = $state(false);
	let busy = $state(false);
	let error = $state<string | null>(null);
	let title = $state('');
	let brief = $state('');
	let assignee = $state('');
	let target = $state('');

	/** Which task is one click from being cancelled, and what went wrong last. */
	let confirming = $state<string | null>(null);
	let rowError = $state<{ id: string; message: string } | null>(null);

	/** The project a new task goes to: the one on screen, or the one picked. */
	const destination = $derived(project ?? target);

	function close(): void {
		open = false;
		error = null;
		title = '';
		brief = '';
		assignee = '';
		target = '';
	}

	async function create(): Promise<void> {
		busy = true;
		error = null;
		try {
			await actions.createTask({
				project: destination,
				title: title.trim(),
				body: brief.trim() === '' ? null : brief.trim(),
				agentId: assignee === '' ? null : assignee
			});
			close();
		} catch (cause) {
			// The form stays open holding what was typed: retyping a brief to find
			// out the title was the problem is nobody's idea of a good time.
			error = actionMessage(cause);
		} finally {
			busy = false;
		}
	}

	/** One steer, with its refusal shown against the row it was aimed at. */
	async function steer(task: TaskView, work: () => Promise<unknown>): Promise<void> {
		busy = true;
		rowError = null;
		try {
			await work();
			confirming = null;
		} catch (cause) {
			rowError = { id: task.id, message: actionMessage(cause) };
		} finally {
			busy = false;
		}
	}

	function reassign(task: TaskView, value: string): void {
		void steer(task, () => actions.patchTask(task.id, { agentId: value === '' ? null : value }));
	}

	function nameFor(agentId: string | null): string | null {
		if (agentId === null) return null;
		return agentNames[agentId] ?? agentId;
	}
</script>

<!--
	`min-w-0` and the wrapping below are load-bearing rather than tidiness: a task
	title is owner-written prose and a brief can carry a path or a URL with no
	break in it, and one of those dragging a 360px layout viewport wider would
	zoom the whole dashboard out (design §7).
-->
<div class="flex min-w-0 flex-col gap-3 text-sm" data-testid="tasks-panel">
	<div class="flex items-center justify-between gap-2">
		<h2 class="text-xs font-semibold tracking-wide text-content-muted uppercase">
			Tasks
			{#if tasks.openCount > 0}
				<span
					class="ml-1 rounded-full bg-surface-raised px-1.5 py-0.5 text-[0.65rem] tabular-nums"
					aria-hidden="true"
				>
					{tasks.openCount}
				</span>
			{/if}
		</h2>

		<button
			type="button"
			aria-expanded={open}
			onclick={() => (open ? close() : (open = true))}
			class="flex min-h-11 items-center gap-1.5 rounded px-2 text-xs font-medium text-content-muted hover:bg-surface-raised hover:text-content"
		>
			<svg class="size-3" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
				<path d="M5 1h2v4h4v2H7v4H5V7H1V5h4z" />
			</svg>
			New task
		</button>
	</div>

	{#if open}
		<div class="flex flex-col gap-2 rounded border border-border-subtle bg-surface-raised p-2">
			{#if project === null}
				<!--
					Only on the all-projects view. With one project on screen the answer
					is already known, and a select offering it back would be a question
					with one answer.
				-->
				<label class="flex flex-col gap-1 text-xs text-content-muted">
					Project
					<select
						bind:value={target}
						class="min-h-11 rounded border border-border-subtle bg-surface px-2 text-sm text-content"
					>
						<option value="">Choose a project</option>
						{#each projects as candidate (candidate.id)}
							<option value={candidate.slug}>{candidate.name}</option>
						{/each}
					</select>
				</label>
			{/if}

			<label class="flex flex-col gap-1 text-xs text-content-muted">
				Task title
				<input
					bind:value={title}
					type="text"
					class="min-h-11 rounded border border-border-subtle bg-surface px-2 text-sm text-content"
				/>
			</label>

			<label class="flex flex-col gap-1 text-xs text-content-muted">
				Brief
				<textarea
					bind:value={brief}
					rows="2"
					class="rounded border border-border-subtle bg-surface px-2 py-1 text-sm text-content"
				></textarea>
			</label>

			<label class="flex flex-col gap-1 text-xs text-content-muted">
				Assign to
				<select
					bind:value={assignee}
					class="min-h-11 rounded border border-border-subtle bg-surface px-2 text-sm text-content"
				>
					<!--
						Unassigned is the default on purpose: a task on the open queue is
						claimable by whichever agent gets to it, which is the case the
						atomic claim exists for (design §5).
					-->
					<option value="">Anyone</option>
					{#each agents as agent (agent.id)}
						<option value={agent.id}>{agent.name}</option>
					{/each}
				</select>
			</label>

			{#if error}
				<p role="alert" class="text-xs text-rose-400">{error}</p>
			{/if}

			<div class="flex flex-wrap justify-end gap-2">
				<button
					type="button"
					onclick={close}
					class="min-h-11 rounded px-3 text-xs text-content-muted hover:text-content"
				>
					Discard
				</button>
				<button
					type="button"
					disabled={busy || title.trim() === '' || destination === ''}
					onclick={create}
					class="min-h-11 rounded bg-accent px-3 text-xs font-medium text-surface disabled:opacity-50"
				>
					Create task
				</button>
			</div>
		</div>
	{/if}

	{#if tasks.items.length === 0}
		<p class="text-content-muted">No tasks yet.</p>
	{:else}
		{#each groups as group (group.key)}
			{#if group.items.length > 0}
				<section class="flex min-w-0 flex-col gap-1.5">
					<h3 class="text-xs font-semibold tracking-wide text-content-muted uppercase">
						{group.label}
						<span class="tabular-nums">({group.items.length})</span>
					</h3>

					<ul class="flex min-w-0 flex-col gap-1.5">
						{#each group.items as task (task.id)}
							<li
								aria-label={task.title}
								data-state={task.state}
								class="update-enter flex min-w-0 flex-col gap-1 rounded border border-border-subtle bg-surface-raised p-2"
							>
								<!--
									Owner-written text, rendered as text: `body` and `result` are
									shown the way they were typed and never as markup, which is
									the same rule the timeline keeps for agent markdown (§8).
								-->
								<p style="overflow-wrap:anywhere" class="min-w-0 font-medium text-content">
									{task.title}
								</p>
								{#if task.body !== ''}
									<p style="overflow-wrap:anywhere" class="min-w-0 text-xs text-content-muted">
										{task.body}
									</p>
								{/if}

								{#if task.state === 'done' && task.result}
									<p style="overflow-wrap:anywhere" class="min-w-0 text-xs text-content">
										{task.result}
									</p>
								{/if}

								{#if task.state === 'todo' || task.state === 'claimed'}
									<div class="flex min-w-0 flex-wrap items-center gap-2">
										<label
											class="flex min-w-0 flex-1 flex-col gap-0.5 text-[0.65rem] text-content-muted"
										>
											<select
												aria-label="Assignee for {task.title}"
												value={task.agentId ?? ''}
												onchange={(event) => reassign(task, event.currentTarget.value)}
												disabled={busy}
												class="min-h-11 w-full min-w-0 rounded border border-border-subtle bg-surface px-2 text-xs text-content"
											>
												<option value="">Unassigned</option>
												{#each agents as agent (agent.id)}
													<option value={agent.id}>{agent.name}</option>
												{/each}
											</select>
										</label>

										<button
											type="button"
											disabled={busy}
											aria-label="Cancel task {task.title}"
											onclick={() => {
												confirming = task.id;
												rowError = null;
											}}
											class="min-h-11 rounded border border-border-subtle px-2 text-xs text-content-muted hover:text-rose-400 disabled:opacity-50"
										>
											Cancel
										</button>
									</div>
								{:else if task.agentId}
									<p class="text-xs text-content-muted">{nameFor(task.agentId)}</p>
								{/if}

								{#if confirming === task.id}
									<!--
										Two clicks, and an inline confirmation rather than
										`window.confirm`: a native dialog is untestable,
										unstyleable, and blocks the tab including the stream.
									-->
									<div
										role="group"
										aria-label="Confirm cancel"
										class="flex flex-wrap items-center gap-2 rounded border border-border-subtle bg-surface px-2 py-1.5 text-xs"
									>
										<span class="text-content">Cancel this task?</span>
										<button
											type="button"
											disabled={busy}
											onclick={() =>
												steer(task, () => actions.patchTask(task.id, { state: 'cancelled' }))}
											class="min-h-11 rounded bg-rose-600 px-2 font-medium text-white disabled:opacity-50"
										>
											Confirm cancel
										</button>
										<button
											type="button"
											disabled={busy}
											onclick={() => (confirming = null)}
											class="min-h-11 rounded border border-border-subtle px-2 text-content-muted hover:text-content"
										>
											Keep it
										</button>
									</div>
								{/if}

								{#if rowError?.id === task.id}
									<p role="alert" class="text-xs text-rose-400">{rowError.message}</p>
								{/if}

								<!--
									The conversation about this task. Same component as the one on
									an update card, so a reply here behaves identically: the write
									publishes `message.created`, the tab hears it and refetches,
									and the message appears the same way it does in a tab that was
									only watching.
								-->
								<Thread
									messages={threads?.forTask(task.id) ?? []}
									{agentNames}
									onreply={async (body) => {
										await actions.postMessage({ task: task.id, body });
									}}
								/>
							</li>
						{/each}
					</ul>
				</section>
			{/if}
		{/each}
	{/if}
</div>
