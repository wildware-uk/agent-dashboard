<script lang="ts">
	/**
	 * The right rail (design §7): live agents, and open tasks when they land.
	 *
	 * Presence is derived, never a stored flag (§4), and this component is where
	 * that becomes visible: it renders `presence.online`, which the store
	 * recomputes against a clock ticking once a second. An agent that stops
	 * beating therefore falls off the rail on time without any event arriving to
	 * say so — because nothing happens when an agent goes quiet, and a UI that
	 * waited for something to happen would show a green dot next to a dead run.
	 *
	 * The store is a prop with a default so the rail is self-contained in the
	 * shell and injectable in a spec. Open tasks are still a placeholder: that is
	 * the control-plane slice's slot, and inventing an empty state for data this
	 * component cannot fetch would be a claim rather than a rendering.
	 */
	import { onMount } from 'svelte';
	import Avatar from './Avatar.svelte';
	import { Presence, heartbeatLabel } from './presence.svelte';

	let { presence = new Presence() }: { presence?: Presence } = $props();

	onMount(() => {
		presence.start();
		return () => presence.stop();
	});

	const agents = $derived(presence.online);
</script>

<div class="flex flex-col gap-6 p-3 text-sm" data-rail>
	<section class="flex flex-col gap-2">
		<h2
			class="flex items-center gap-2 text-xs font-semibold tracking-wide text-content-muted uppercase"
		>
			Live agents
			{#if agents.length > 0}
				<span
					class="rounded-full bg-surface-raised px-1.5 py-0.5 text-[0.65rem] text-content-muted tabular-nums"
					aria-hidden="true"
				>
					{agents.length}
				</span>
			{/if}
		</h2>

		{#if agents.length === 0}
			<!--
				Now a real empty state rather than a promise: presence exists, so
				"nobody is working" is something this rail can honestly say.
			-->
			<p class="text-content-muted">No agents online.</p>
		{:else}
			<ul class="flex flex-col gap-3">
				{#each agents as agent (agent.agentId)}
					<li class="update-enter flex items-start gap-2">
						<Avatar name={agent.name} class="size-7" />
						<div class="flex min-w-0 flex-col gap-0.5">
							<div class="flex items-center gap-1.5">
								<span class="size-2 shrink-0 rounded-full bg-emerald-500" aria-hidden="true"></span>
								<span class="truncate font-medium text-content">{agent.name}</span>
								<span class="sr-only">online</span>
								{#if agent.sessions > 1}
									<span class="shrink-0 text-xs text-content-muted">
										{agent.sessions} sessions
									</span>
								{/if}
							</div>

							<dl class="flex flex-col gap-0.5 text-xs text-content-muted">
								{#if agent.model}
									<div class="flex gap-1">
										<dt class="sr-only">Model</dt>
										<dd class="truncate">{agent.model}</dd>
									</div>
								{/if}
								{#if agent.host}
									<div class="flex gap-1">
										<dt class="sr-only">Host</dt>
										<!-- Agent-authored text, so it is rendered as text and never as markup. -->
										<dd class="truncate">{agent.host}</dd>
									</div>
								{/if}
								{#if agent.cwd}
									<div class="flex gap-1">
										<dt class="sr-only">Working directory</dt>
										<dd class="truncate font-mono" title={agent.cwd}>{agent.cwd}</dd>
									</div>
								{/if}
								<div class="flex gap-1">
									<dt class="sr-only">Last heartbeat</dt>
									<dd class="tabular-nums">
										{heartbeatLabel(agent.lastHeartbeatAt, presence.now)}
									</dd>
								</div>
							</dl>
						</div>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<section class="flex flex-col gap-2">
		<h2 class="text-xs font-semibold tracking-wide text-content-muted uppercase">Open tasks</h2>
		<p class="text-content-muted">Tasks arrive with the control-plane slice.</p>
	</section>
</div>
