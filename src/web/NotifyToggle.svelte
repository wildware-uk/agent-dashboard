<script lang="ts">
	/**
	 * Turn Web Push on for this browser (design §7).
	 *
	 * **It is a button, not a prompt on load.** The permission dialog is raised
	 * from a click and nowhere else: a page that asks the moment it opens is one
	 * people deny permanently, and `denied` cannot be undone from script — only in
	 * the browser's own site settings, which is what the disabled state says.
	 *
	 * **It hides itself when there is nothing to offer.** No keypair on the
	 * deployment, or a browser without the APIs (Safari in a tab has neither), and
	 * the header simply does not grow a control that could not work.
	 *
	 * The state it renders is derived from the browser on mount rather than
	 * remembered, because a permission or a subscription can be revoked from
	 * outside this app entirely (`push.svelte.ts`).
	 */
	import { onMount } from 'svelte';
	import { Push, type PushPrefs } from './push.svelte';

	let {
		/** Injected by the specs; the shell builds its own. */
		push = new Push()
	}: { push?: Push } = $props();

	onMount(() => {
		void push.load();
	});

	let settings = $state(false);

	const blocked = $derived(push.permission === 'denied');

	/**
	 * The three axes an owner actually filters on (design §7).
	 *
	 * Kept as data rather than markup so the panel is a loop: every one is an
	 * independent whitelist, and the server judges a notification against all
	 * three (`src/domain/push.ts`).
	 */
	const AXES = [
		{
			key: 'types' as const,
			label: 'Tell me about',
			options: [
				{ value: 'request', label: 'Questions' },
				// Two rows rather than one "Replies", because they are two events: an
				// agent answering you, and an agent leaving a note on a thread. The
				// second is the one worth being able to switch off on a phone.
				{ value: 'message', label: 'Replies to me' },
				{ value: 'comment', label: 'Comments' },
				{ value: 'update', label: 'Updates' }
			]
		},
		{
			key: 'levels' as const,
			label: 'Update levels',
			options: [
				{ value: 'error', label: 'Error' },
				{ value: 'warn', label: 'Warning' },
				{ value: 'success', label: 'Success' },
				{ value: 'info', label: 'Info' }
			]
		},
		{
			key: 'priorities' as const,
			label: 'Update priority',
			options: [
				{ value: 'high', label: 'High' },
				{ value: 'medium', label: 'Medium' },
				{ value: 'low', label: 'Low' }
			]
		}
	];

	/**
	 * Whether one member is currently allowed.
	 *
	 * An absent list means "no opinion, allow" on every axis — the same rule the
	 * server applies (`DEFAULT_PUSH_TYPES` in `src/domain/push.ts`) — so an owner
	 * who has never opened this panel sees everything ticked, which is what
	 * turning notifications on promised them.
	 */
	function allowed(prefs: PushPrefs, key: (typeof AXES)[number]['key'], value: string): boolean {
		const list = prefs[key];
		return list ? list.includes(value) : true;
	}

	function toggleMember(key: (typeof AXES)[number]['key'], value: string, on: boolean): void {
		const axis = AXES.find((candidate) => candidate.key === key)!;
		const current = axis.options
			.map((option) => option.value)
			.filter((member) => allowed(push.prefs, key, member));
		const next = on ? [...current, value] : current.filter((member) => member !== value);

		void push.savePrefs({ ...push.prefs, [key]: next });
	}
	const label = $derived(
		blocked
			? 'Notifications are blocked in your browser settings'
			: push.subscribed
				? 'Turn notifications off for this browser'
				: 'Notify me when an agent is waiting'
	);
</script>

{#if push.available}
	<button
		type="button"
		data-testid="notify-toggle"
		aria-pressed={push.subscribed}
		aria-label={label}
		title={push.error ?? label}
		disabled={push.busy || blocked}
		onclick={() => void push.toggle()}
		class="flex items-center gap-1.5 rounded border px-2 py-1 text-sm transition-colors disabled:opacity-50 {push.subscribed
			? 'border-amber-500/50 bg-amber-500/10 text-amber-600 dark:text-amber-400'
			: 'border-border-subtle text-content-muted hover:text-content'}"
	>
		{#if push.subscribed}
			<svg class="size-4" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
				<path
					d="M8 1.5a4 4 0 0 0-4 4v2.3L2.6 10.2a.6.6 0 0 0 .5.9h9.8a.6.6 0 0 0 .5-.9L12 7.8V5.5a4 4 0 0 0-4-4M6.2 12.2a1.9 1.9 0 0 0 3.6 0z"
				/>
			</svg>
		{:else}
			<svg
				class="size-4"
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				stroke-width="1.4"
				aria-hidden="true"
			>
				<path
					d="M8 2.2a3.3 3.3 0 0 0-3.3 3.3v2.4L3.4 10.3h9.2l-1.3-2.4V5.5A3.3 3.3 0 0 0 8 2.2M6.5 12.2a1.6 1.6 0 0 0 3 0"
					stroke-linejoin="round"
				/>
			</svg>
		{/if}
		<!--
			The word is hidden on a phone, where the header is already two drawer
			toggles, a title, a status dot, a theme switch and a sign-out. The icon
			plus `aria-label` carries it; the label is never the only signal.
		-->
		<span class="hidden sm:inline">{push.subscribed ? 'Notifying' : 'Notify me'}</span>
	</button>

	{#if push.subscribed}
		<div class="relative">
			<button
				type="button"
				data-testid="notify-settings"
				aria-label="What this device is notified about"
				aria-expanded={settings}
				onclick={() => (settings = !settings)}
				class="rounded border border-border-subtle px-1.5 py-1 text-xs text-content-muted hover:text-content"
			>
				⋯
			</button>

			{#if settings}
				<!--
					Per device, and it says so: these settings belong to the browser they
					are set in, because "buzz my phone for questions only, tell my laptop
					everything" is one owner with two rules rather than two owners.
				-->
				<div
					data-testid="notify-panel"
					class="absolute right-0 z-30 mt-1 flex w-60 flex-col gap-3 rounded border border-border-subtle bg-surface-raised p-3 text-sm shadow-lg"
				>
					{#each AXES as axis (axis.key)}
						<fieldset class="flex flex-col gap-1">
							<legend class="text-xs font-medium text-content-muted">{axis.label}</legend>
							{#each axis.options as option (option.value)}
								<label class="flex items-center gap-2 text-xs text-content">
									<input
										type="checkbox"
										disabled={push.busy}
										checked={allowed(push.prefs, axis.key, option.value)}
										onchange={(event) =>
											toggleMember(axis.key, option.value, event.currentTarget.checked)}
										class="size-3.5 shrink-0"
									/>
									{option.label}
								</label>
							{/each}
						</fieldset>
					{/each}

					<p class="text-xs text-content-muted">
						This device only. Levels and priority apply to updates; a question is a blocked agent
						and has neither.
					</p>

					{#if push.error}
						<p role="alert" class="text-xs text-rose-400">{push.error}</p>
					{/if}
				</div>
			{/if}
		</div>
	{/if}
{/if}
