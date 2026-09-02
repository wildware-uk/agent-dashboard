<script lang="ts">
	/**
	 * The bell: everything the owner has been told about, in the app
	 * (migration 021).
	 *
	 * Their ask was two things. **Accessible** — a push that arrived while the
	 * phone was asleep used to be the only copy, so the list is the record now
	 * and push is one delivery of it. And **it takes you there** — every row is a
	 * link to the card or the reply itself, not to the top of a project with
	 * fifty cards under it.
	 *
	 * Clicking a row marks that one read, not the lot: opening one reply must not
	 * quietly wipe a list the owner had not looked at. "Mark all read" is a
	 * separate, deliberate act.
	 *
	 * The panel is a plain button and a list rather than a popover API: it has to
	 * work on a phone, where a hover-anything is a control that does not exist.
	 */
	import { onMount } from 'svelte';
	import { clock } from './clock.svelte';
	import { relativeLabel, absoluteLabel } from './days';
	import type { Notifications } from './notifications.svelte';

	let {
		/** The store. Absent renders nothing at all, which is what a spec without one wants. */
		notifications,
		/** Navigate. Defaults to a full page load, which is correct without a router. */
		go = (path: string) => {
			window.location.href = path;
		}
	}: {
		notifications?: Notifications;
		go?: (path: string) => void;
	} = $props();

	let open = $state(false);

	const items = $derived(notifications?.items ?? []);
	const unseen = $derived(notifications?.unseen ?? 0);

	/** The page's one ticking clock, so "4m ago" keeps up (design §7). */
	const ticking = clock();
	onMount(() => ticking.hold());

	async function opened(id: string, path: string): Promise<void> {
		open = false;
		// Marked before navigating, and only this one: a list that cleared itself
		// because one row was read would lose the rest without being asked.
		await notifications?.markSeen([id]);
		go(path);
	}
</script>

{#if notifications}
	<div class="relative">
		<button
			type="button"
			aria-expanded={open}
			aria-label={unseen > 0 ? `Notifications, ${unseen} unread` : 'Notifications'}
			onclick={() => (open = !open)}
			class="relative rounded border border-border-subtle p-1.5 text-content-muted hover:text-content"
		>
			<svg class="size-4" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
				<path
					d="M8 1.5a3.5 3.5 0 0 0-3.5 3.5v2.2L3.2 10.2A.6.6 0 0 0 3.8 11h8.4a.6.6 0 0 0 .6-.8l-1.3-3V5A3.5 3.5 0 0 0 8 1.5zM6.4 12a1.6 1.6 0 0 0 3.2 0z"
				/>
			</svg>
			{#if unseen > 0}
				<span
					data-unseen
					class="absolute -top-1 -right-1 min-w-4 rounded-full bg-accent px-1 text-[10px] leading-4 font-medium text-surface tabular-nums"
				>
					{unseen > 99 ? '99+' : unseen}
				</span>
			{/if}
		</button>

		{#if open}
			<!--
				Anchored to the button on a wide screen and pinned to the edges on a
				phone, where "next to the bell" would run off the side of the display.
			-->
			<div
				data-notifications
				class="fixed inset-x-2 top-14 z-30 max-h-[70vh] overflow-y-auto rounded-lg border border-border-subtle bg-surface-raised shadow-lg sm:absolute sm:inset-x-auto sm:top-full sm:right-0 sm:mt-1 sm:w-96"
			>
				<div
					class="flex items-center justify-between border-b border-border-subtle px-3 py-2 text-xs"
				>
					<span class="font-medium text-content">Notifications</span>
					{#if unseen > 0}
						<button
							type="button"
							onclick={() => notifications?.markSeen()}
							class="rounded px-1.5 py-0.5 text-content-muted hover:bg-surface hover:text-content"
						>
							Mark all read
						</button>
					{/if}
				</div>

				{#if items.length === 0}
					<p class="px-3 py-6 text-center text-xs text-content-muted">
						Nothing yet. Updates, replies and anything an agent is waiting on you for land here.
					</p>
				{:else}
					<ul>
						{#each items as item (item.id)}
							<li>
								<button
									type="button"
									data-notification={item.id}
									data-unread={item.seenAt === null ? 'true' : undefined}
									onclick={() => opened(item.id, item.path)}
									class="flex w-full flex-col gap-0.5 border-b border-border-subtle px-3 py-2 text-left last:border-b-0 hover:bg-surface {item.seenAt ===
									null
										? 'bg-surface-raised'
										: 'opacity-70'}"
								>
									<span class="flex items-baseline gap-2 text-xs">
										<span class="truncate font-medium text-content">{item.title}</span>
										<time
											class="ml-auto shrink-0 text-content-muted"
											datetime={new Date(item.createdAt).toISOString()}
											title={absoluteLabel(item.createdAt)}
										>
											{relativeLabel(item.createdAt, ticking.now)}
										</time>
									</span>
									<span class="line-clamp-2 text-xs text-content-muted">{item.body}</span>
									{#if item.projectName}
										<span class="text-[11px] text-content-muted">{item.projectName}</span>
									{/if}
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		{/if}
	</div>
{/if}
