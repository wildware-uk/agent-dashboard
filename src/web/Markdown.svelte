<script lang="ts">
	/**
	 * Agent-authored markdown, rendered with raw HTML disabled (design §8).
	 *
	 * This is the only `{@html}` in the client, and the only string it will ever
	 * accept is the return value of `renderMarkdown` — which escapes every raw
	 * tag rather than sanitising it. Keeping the pair in one four-line component
	 * is what makes that reviewable: if this file is unchanged, no agent can
	 * inject markup into the owner's browser.
	 */
	import { renderMarkdown } from './markdown';

	let { body }: { body: string } = $props();

	const html = $derived(renderMarkdown(body));
</script>

{#if html !== ''}
	<div
		class="prose prose-sm max-w-none break-words dark:prose-invert prose-headings:font-semibold prose-pre:bg-surface-sunken prose-pre:text-content"
	>
		<!-- eslint-disable-next-line svelte/no-at-html-tags -- escaped by renderMarkdown; see above -->
		{@html html}
	</div>
{/if}
