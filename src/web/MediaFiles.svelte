<script lang="ts">
	/**
	 * The files attached to a card, as things you can download (migration 026).
	 *
	 * The owner asked to be able to send agents any file, not just pictures, and
	 * an agent can send one back. A zip has nothing to render, so this is a list
	 * of rows rather than a grid of squares: a name, a size, and a link — which
	 * is the whole of what a download needs to be useful.
	 *
	 * The link is an ordinary `<a href>` to `/media/:id/original`, and it is the
	 * *server* that makes it a download: that route answers
	 * `application/octet-stream` with `Content-Disposition: attachment`
	 * (`src/http/media/serve.ts`). A `download` attribute here would be a hint the
	 * browser may ignore; the header is the rule, and it is the same rule that
	 * stops an uploaded `.html` becoming a page on this origin.
	 *
	 * Pending and failed are shown rather than hidden, for the same reason a
	 * picture's placeholder is: an attachment that quietly vanished reads as the
	 * send having missed.
	 */
	import { downloadUrl, fileName, fileSize, mediaLabel } from './media';
	import type { MediaView } from './types';

	let {
		items = [],
		/**
		 * Prefix for the media address, for a share page serving from `/s/:token`.
		 * Empty on the dashboard itself.
		 */
		prefix = ''
	}: { items?: MediaView[]; prefix?: string } = $props();
</script>

{#if items.length > 0}
	<ul data-media-files class="flex flex-col gap-1">
		{#each items as item, index (item.id)}
			{@const href = downloadUrl(item, prefix)}
			<li data-media-file={item.id} data-media-state={item.status}>
				{#if item.status === 'ready' && href}
					<!--
						A media address, not a route: it is built in one place
						(`./media.ts`) and is root-relative on purpose, which is what the
						lint rule protects against and cannot see through. `resolve` is wrong
						here for the same reason it is wrong on a shared card — it answers
						with a path relative to the current page, and this address has to
						mean the same thing on `/` and on `/projects/x`.
					-->
					<!-- eslint-disable svelte/no-navigation-without-resolve -->
					<a
						{href}
						aria-label={mediaLabel(item, index, items.length)}
						class="flex items-center gap-2 rounded-md border border-border-subtle bg-surface-sunken px-2.5 py-2 text-sm text-content hover:border-accent focus:outline-2 focus:-outline-offset-2 focus:outline-accent"
					>
						<svg
							class="size-4 shrink-0 text-content-muted"
							viewBox="0 0 16 16"
							fill="currentColor"
							aria-hidden="true"
						>
							<path
								d="M4 1.5A1.5 1.5 0 0 0 2.5 3v10A1.5 1.5 0 0 0 4 14.5h8a1.5 1.5 0 0 0 1.5-1.5V6.2a1.5 1.5 0 0 0-.44-1.06l-3.2-3.2A1.5 1.5 0 0 0 8.8 1.5zm5 1.3 3.2 3.2H9.5A.5.5 0 0 1 9 5.5z"
							/>
						</svg>
						<span class="min-w-0 flex-1 truncate">{fileName(item)}</span>
						<span class="shrink-0 text-xs text-content-muted tabular-nums">
							{fileSize(item.bytes)}
						</span>
					</a>
					<!-- eslint-enable svelte/no-navigation-without-resolve -->
				{:else}
					<div
						class="flex items-center gap-2 rounded-md border border-border-subtle bg-surface-sunken px-2.5 py-2 text-sm text-content-muted"
					>
						<span class="min-w-0 flex-1 truncate">{fileName(item)}</span>
						<span class="shrink-0 text-xs">
							{item.status === 'failed' ? 'unavailable' : 'storing…'}
						</span>
					</div>
				{/if}
			</li>
		{/each}
	</ul>
{/if}
