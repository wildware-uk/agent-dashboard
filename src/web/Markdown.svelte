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
		class="markdown-body prose prose-sm max-w-none break-words dark:prose-invert prose-headings:font-semibold prose-pre:bg-surface-sunken prose-pre:text-content"
	>
		<!-- eslint-disable-next-line svelte/no-at-html-tags -- escaped by renderMarkdown; see above -->
		{@html html}
	</div>
{/if}

<style>
	/*
		Wide content scrolls inside itself rather than widening the page (design §7).
		`.md-scroll` wraps every table; `pre` already scrolls but still needs a max
		width, or its own min-content pushes the column out on a phone.
	*/
	.markdown-body :global(.md-scroll) {
		max-width: 100%;
		overflow-x: auto;
	}

	.markdown-body :global(pre) {
		max-width: 100%;
		overflow-x: auto;
	}

	/*
		An agent writing "# Heading" means a section of its update, not a page title.
		Prose's default scale renders that at display size, which on a phone eats a
		third of the screen before a word of the actual status is read. Cap the whole
		scale to something a card can hold, keeping the relative steps.
	*/
	.markdown-body :global(h1) {
		font-size: 1.05rem;
		line-height: 1.4;
		margin-top: 1em;
		margin-bottom: 0.4em;
	}

	.markdown-body :global(h2) {
		font-size: 0.975rem;
		line-height: 1.4;
		margin-top: 0.9em;
		margin-bottom: 0.35em;
	}

	.markdown-body :global(h3),
	.markdown-body :global(h4),
	.markdown-body :global(h5),
	.markdown-body :global(h6) {
		font-size: 0.9rem;
		line-height: 1.4;
		margin-top: 0.8em;
		margin-bottom: 0.3em;
	}
</style>
