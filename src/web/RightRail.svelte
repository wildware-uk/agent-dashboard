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
	 * The store is a prop with a default: the shell owns one and hands it down,
	 * because the timeline needs the names presence learns as much as the rail
	 * needs the heartbeats, and a spec can inject its own. Starting it here as
	 * well as in the shell is deliberate and free — `start` and `stop` are
	 * idempotent — so the rail still works on its own.
	 *
	 * Tasks are the rail's other half in design §7, and they exist now: the shell
	 * renders `Tasks.svelte` under this component, in the same column. They are
	 * not mounted from in here because the task panel writes as well as reads — it
	 * needs the owner's actions, the project list and the agent names, all of
	 * which the shell already holds — and a rail that reached for those itself
	 * would be a second place they are wired.
	 */
	import { onMount } from 'svelte';
	import Avatar from './Avatar.svelte';
	import { actionMessage, type OwnerActions } from './actions';
	import { Presence, heartbeatLabel } from './presence.svelte';

	let {
		presence = new Presence(),
		/**
		 * The owner's write calls (design §7). Given one, each agent's name becomes
		 * editable; without one the rail is the read-only list it always was.
		 */
		actions
	}: { presence?: Presence; actions?: OwnerActions } = $props();

	/** Which agent is being renamed, and what it is being renamed to. */
	let editing = $state<string | null>(null);
	let draft = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);

	function start(agentId: string, name: string): void {
		editing = agentId;
		draft = name;
		error = null;
	}

	async function save(agentId: string): Promise<void> {
		const name = draft.trim();
		if (name === '') return;

		busy = true;
		error = null;
		try {
			await actions?.renameAgent(agentId, name);
			// Nothing is inserted here: the write publishes `agent.renamed`, the tab
			// hears it and refetches, and every card that agent posted is relabelled
			// with the rail. Same rule as every other control on this page.
			editing = null;
		} catch (cause) {
			error = actionMessage(cause);
		} finally {
			busy = false;
		}
	}

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
					<li class="group update-enter flex items-start gap-2">
						<Avatar name={agent.name} class="size-7" />
						<div class="flex min-w-0 flex-col gap-0.5">
							<div class="flex items-center gap-1.5">
								<span class="size-2 shrink-0 rounded-full bg-emerald-500" aria-hidden="true"></span>
								{#if editing === agent.agentId}
									<!--
										A name is the one thing about an agent the owner authors —
										its token is its identity — so this edits in place rather
										than opening a dialog for one field.
									-->
									<input
										bind:value={draft}
										aria-label="Name for {agent.name}"
										disabled={busy}
										onkeydown={(event) => {
											if (event.key === 'Enter') void save(agent.agentId);
											if (event.key === 'Escape') editing = null;
										}}
										class="min-w-0 flex-1 rounded border border-border-subtle bg-surface px-1.5 py-0.5 text-sm text-content"
									/>
									<button
										type="button"
										disabled={busy || draft.trim() === ''}
										onclick={() => save(agent.agentId)}
										class="shrink-0 rounded px-1.5 text-xs font-medium text-accent disabled:opacity-50"
									>
										Save
									</button>
								{:else}
									<span class="truncate font-medium text-content">{agent.name}</span>
									<span class="sr-only">online</span>
									{#if actions}
										<button
											type="button"
											data-testid="rename-agent"
											aria-label="Rename {agent.name}"
											onclick={() => start(agent.agentId, agent.name)}
											class="shrink-0 rounded px-1 text-xs text-content-muted opacity-0 group-hover:opacity-100 hover:text-content focus:opacity-100"
										>
											Rename
										</button>
									{/if}
								{/if}
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

							{#if error && editing === agent.agentId}
								<p role="alert" class="text-xs text-rose-400">{error}</p>
							{/if}
						</div>
					</li>
				{/each}
			</ul>
		{/if}
	</section>
</div>
