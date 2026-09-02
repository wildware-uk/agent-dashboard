<script lang="ts">
	/**
	 * One task and the work under it (design §7).
	 *
	 * The page answers three questions in the order an owner asks them: what state
	 * is this in, what is the latest, and what has happened. State first because it
	 * is why the page was opened; the newest update as "current status" because a
	 * task that has been claimed for two days says nothing on its own and its most
	 * recent report says everything.
	 */
	import Markdown from '$web/Markdown.svelte';
	import UpdateCard from '$web/UpdateCard.svelte';
	import Thread from '$web/Thread.svelte';
	import { agentLabel } from '$web/avatar';
	import { absoluteLabel, relativeLabel } from '$web/days';
	import { ownerActions } from '$web/actions';
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	/** The state, said in the owner's words rather than the column's. */
	const STATES = {
		todo: { label: 'Waiting to be claimed', tone: 'bg-sky-500/15 text-sky-700 dark:text-sky-300' },
		claimed: {
			label: 'In progress',
			tone: 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
		},
		done: { label: 'Done', tone: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' },
		cancelled: { label: 'Cancelled', tone: 'bg-content-muted/15 text-content-muted' }
	};

	const state = $derived(STATES[data.task.state]);
	const holder = $derived(
		data.task.agentId ? agentLabel(data.task.agentId, data.agentNames[data.task.agentId]) : null
	);
	/** The most recent report, which is what "how is it going" actually means. */
	const latest = $derived(data.updates[0] ?? null);

	const actions = ownerActions();

	/**
	 * Reply into the task's thread.
	 *
	 * This page is a server render rather than a live store, so the reply is
	 * followed by a reload of its own data — the alternative is a message the
	 * owner just wrote not appearing until they refresh, which is the one thing
	 * worse than not being live at all.
	 */
	async function reply(body: string): Promise<void> {
		await actions.postMessage({ task: data.task.id, body });
		await invalidateAll();
	}
</script>

<svelte:head><title>{data.task.title} · Agent Dashboard</title></svelte:head>

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

		<header
			class="flex flex-col gap-3 rounded-lg border border-border-subtle bg-surface-raised p-4"
		>
			<div class="flex flex-wrap items-center gap-2">
				<span class="rounded px-2 py-0.5 text-xs font-medium {state.tone}" data-testid="task-state">
					{state.label}
				</span>
				{#if holder}
					<span class="text-xs text-content-muted">{holder}</span>
				{/if}
				<time
					class="ml-auto text-xs text-content-muted"
					datetime={new Date(data.task.createdAt).toISOString()}
					title={absoluteLabel(data.task.createdAt)}
				>
					opened {relativeLabel(data.task.createdAt)}
				</time>
			</div>

			<h1 class="text-xl font-semibold tracking-tight">{data.task.title}</h1>

			{#if data.task.body}
				<div class="text-sm text-content-muted"><Markdown body={data.task.body} /></div>
			{/if}

			<!--
				Current status: the newest update filed against this task, or the
				result if it is finished. A claimed task with neither has been picked
				up and not reported on, and saying so plainly beats an empty panel.
			-->
			<div class="rounded border border-border-subtle bg-surface p-3" data-testid="task-status">
				<span class="text-xs font-medium text-content-muted">Current status</span>
				{#if data.task.state === 'done' && data.task.result}
					<div class="mt-1 text-sm"><Markdown body={data.task.result} /></div>
				{:else if latest}
					<div class="mt-1 text-sm"><Markdown body={latest.body} /></div>
					<span class="mt-1 block text-xs text-content-muted">
						{relativeLabel(latest.createdAt)}
					</span>
				{:else}
					<p class="mt-1 text-sm text-content-muted">
						{data.task.state === 'claimed'
							? 'Claimed, but nothing has been reported against it yet.'
							: 'Nothing reported yet.'}
					</p>
				{/if}
			</div>
		</header>

		<section class="flex flex-col gap-3" aria-labelledby="task-updates">
			<h2
				id="task-updates"
				class="px-1 text-xs font-semibold tracking-wide text-content-muted uppercase"
			>
				{data.updates.length}
				{data.updates.length === 1 ? 'update' : 'updates'} on this task
			</h2>

			{#if data.updates.length === 0}
				<p class="px-1 py-6 text-sm text-content-muted">
					Nothing has been filed against this task. Agents link an update to a task by passing
					<code class="rounded bg-surface-raised px-1.5 py-0.5">task_id</code> to
					<code class="rounded bg-surface-raised px-1.5 py-0.5">post_update</code>.
				</p>
			{:else}
				{#each data.updates as update (update.id)}
					<UpdateCard {update} agentName={data.agentNames[update.agentId]} />
				{/each}
			{/if}
		</section>

		<section class="rounded-lg border border-border-subtle bg-surface-raised p-4">
			<h2 class="mb-2 text-xs font-semibold tracking-wide text-content-muted uppercase">
				Conversation
			</h2>
			<Thread messages={data.messages} agentNames={data.agentNames} onreply={reply} />
		</section>
	</div>
</main>
