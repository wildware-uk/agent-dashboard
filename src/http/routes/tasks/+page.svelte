<script lang="ts">
	/**
	 * The tasks page (design §7).
	 *
	 * Grouped by state, in the order an owner cares about them: what is being
	 * worked on, what is waiting for somebody, and then everything that is over.
	 * Each row goes to the task's own page, which is where its updates and current
	 * status live.
	 */
	import { resolve } from '$app/paths';
	import Ack from '$web/Ack.svelte';
	import { agentLabel } from '$web/avatar';
	import { absoluteLabel, relativeLabel } from '$web/days';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	/**
	 * What agents have said about a task, by task id (migration 013).
	 *
	 * This page renders **only the ticks**, which is what leaving `onlineIds`
	 * empty does: it is server-rendered and has no stream, so a "… is thinking…"
	 * would be correct at load and then frozen — an animation that goes on
	 * claiming an agent is busy long after its session ended is the one thing
	 * that feature is not allowed to do. A tick is a fact about the past and
	 * renders honestly anywhere. The live views (the board, the rail, a card's
	 * thread) hold presence and show both.
	 */
	const acksFor = $derived.by(() => {
		const map: Record<string, PageData['acks']> = {};
		for (const ack of data.acks) {
			if (ack.taskId === null) continue;
			(map[ack.taskId] ??= []).push(ack);
		}
		return map;
	});

	const GROUPS = [
		{ state: 'claimed' as const, label: 'In progress', empty: 'Nothing is being worked on.' },
		{ state: 'todo' as const, label: 'Waiting', empty: 'Nothing is waiting to be picked up.' },
		{ state: 'done' as const, label: 'Done', empty: 'Nothing finished yet.' },
		{ state: 'cancelled' as const, label: 'Cancelled', empty: '' }
	];

	const grouped = $derived(
		GROUPS.map((group) => ({
			...group,
			items: data.tasks.filter((task) => task.state === group.state)
		}))
			// A cancelled section on a board that has never cancelled anything is a
			// heading explaining its own absence.
			.filter((group) => group.items.length > 0 || group.empty !== '')
	);

	const who = (agentId: string | null) =>
		agentId ? agentLabel(agentId, data.agentNames[agentId]) : null;

	/** The instant a row is stamped with: when it moved, not when it was made. */
	const movedAt = (task: PageData['tasks'][number]) =>
		task.doneAt ?? task.claimedAt ?? task.createdAt;
</script>

<svelte:head>
	<title>Tasks{data.project ? ` · ${data.project.name}` : ''} · Agent Dashboard</title>
</svelte:head>

<main class="min-h-dvh bg-surface px-3 py-6 text-content sm:px-4">
	<div class="mx-auto flex max-w-3xl flex-col gap-5">
		<nav class="text-xs text-content-muted">
			<a class="hover:text-content" href={resolve('/')}>Dashboard</a>
			{#if data.project}
				<span aria-hidden="true">/</span>
				<a
					class="hover:text-content"
					href={resolve('/projects/[slug]', { slug: data.project.slug })}
				>
					{data.project.name}
				</a>
			{/if}
		</nav>

		<h1 class="text-xl font-semibold tracking-tight">
			Tasks{data.project ? ` · ${data.project.name}` : ''}
		</h1>

		{#each grouped as group (group.state)}
			<section class="flex flex-col gap-2" aria-labelledby="tasks-{group.state}">
				<h2
					id="tasks-{group.state}"
					class="px-1 text-xs font-semibold tracking-wide text-content-muted uppercase"
				>
					{group.label}
					{#if group.items.length > 0}
						<span class="tabular-nums">({group.items.length})</span>
					{/if}
				</h2>

				{#if group.items.length === 0}
					<p class="px-1 pb-1 text-sm text-content-muted">{group.empty}</p>
				{:else}
					<ul class="flex flex-col gap-2">
						{#each group.items as task (task.id)}
							<li>
								<a
									href={resolve('/tasks/[id]', { id: task.id })}
									data-testid="task-row"
									data-state={task.state}
									class="flex min-w-0 flex-col gap-1 rounded-lg border border-border-subtle bg-surface-raised p-3 hover:border-content-muted"
								>
									<span style="overflow-wrap:anywhere" class="min-w-0 font-medium text-content">
										{task.title}
									</span>
									{#if task.body !== ''}
										<span
											style="overflow-wrap:anywhere"
											class="line-clamp-2 min-w-0 text-xs text-content-muted"
										>
											{task.body}
										</span>
									{/if}
									<Ack acks={acksFor[task.id] ?? []} agentNames={data.agentNames} />
									<span class="flex flex-wrap items-center gap-x-2 text-xs text-content-muted">
										{#if who(task.agentId)}
											<span>{who(task.agentId)}</span>
										{/if}
										<time
											class="ml-auto"
											datetime={new Date(movedAt(task)).toISOString()}
											title={absoluteLabel(movedAt(task))}
										>
											{relativeLabel(movedAt(task))}
										</time>
									</span>
								</a>
							</li>
						{/each}
					</ul>
				{/if}
			</section>
		{/each}
	</div>
</main>
