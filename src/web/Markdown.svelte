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
	import { highlightIn } from './highlight';

	let {
		body,
		/**
		 * Take colours from the surrounding element instead of from the dashboard
		 * theme (migration 027).
		 *
		 * An embed paints its own palette — a Slack card is white on a dark
		 * dashboard — so prose inside one must follow that palette rather than the
		 * page's. The `--tw-prose-*` variables are set on this element rather than
		 * on the embed, because `prose-invert` would set them here too and win.
		 */
		inherit = false
	}: { body: string; inherit?: boolean } = $props();

	const html = $derived(renderMarkdown(body));

	/** The rendered element, so the code inside it can be coloured. */
	let rendered = $state<HTMLElement | null>(null);

	/**
	 * Colour the fenced blocks once the markup is on the page (design §7).
	 *
	 * After the render rather than during it, because the highlighter is a
	 * megabyte of grammars and is fetched only when a card actually has code in
	 * it (`./highlight.ts`). The code is readable in plain monospace the whole
	 * time; the colours arrive a moment later.
	 *
	 * Re-runs when `html` changes — an edited update, a card swapped by id — and
	 * is idempotent, so a block already coloured is left alone.
	 */
	$effect(() => {
		// Reading `html` is what makes this re-run when the body changes: the
		// element is the same node across an edit, so without it the new code would
		// never be looked at.
		if (html !== '') void highlightIn(rendered);
	});
</script>

{#if html !== ''}
	<div
		bind:this={rendered}
		class="markdown-body prose prose-sm max-w-none break-words prose-headings:font-semibold {inherit
			? 'prose-inherit'
			: 'dark:prose-invert prose-pre:bg-surface-sunken prose-pre:text-content'}"
	>
		<!-- eslint-disable-next-line svelte/no-at-html-tags -- escaped by renderMarkdown; see above -->
		{@html html}
	</div>
{/if}

<style>
	/*
		Prose that follows its container rather than the page (migration 027).

		Set on the same element the `prose` classes are on, so there is nothing
		with higher specificity to lose to. The names are Tailwind Typography's own
		knobs, which is why this is a list of assignments rather than a stylesheet.
	*/
	.prose-inherit {
		/*
			Follow the block's own size rather than prose's.

			`prose-sm` sets 14px on this element, which quietly overrode the 15px an
			embed asks for — and 15px is what Slack and GitHub actually render a
			message at, so the card read as a smaller quotation of the real thing.
		*/
		font-size: inherit;
		--tw-prose-body: var(--embed-foreground, currentColor);
		--tw-prose-headings: var(--embed-foreground, currentColor);
		--tw-prose-lead: var(--embed-muted, currentColor);
		--tw-prose-links: var(--embed-accent, currentColor);
		--tw-prose-bold: var(--embed-foreground, currentColor);
		--tw-prose-counters: var(--embed-muted, currentColor);
		--tw-prose-bullets: var(--embed-border, currentColor);
		--tw-prose-hr: var(--embed-border, currentColor);
		--tw-prose-quotes: var(--embed-foreground, currentColor);
		--tw-prose-quote-borders: var(--embed-border, currentColor);
		--tw-prose-captions: var(--embed-muted, currentColor);
		--tw-prose-code: var(--embed-foreground, currentColor);
		--tw-prose-pre-code: var(--embed-foreground, currentColor);
		--tw-prose-pre-bg: color-mix(in oklab, var(--embed-foreground, currentColor) 7%, transparent);
		--tw-prose-th-borders: var(--embed-border, currentColor);
		--tw-prose-td-borders: var(--embed-border, currentColor);
	}

	/*
		No decorative punctuation inside an embed.

		Tailwind Typography wraps a blockquote in curly quotes and inline code in
		literal backticks, both with generated content. That is right for a document
		and wrong for a quoted Slack message or a GitHub comment, neither of which
		shows either — and because the marks are generated, no amount of care in the
		agent's markdown removes them.
	*/
	.prose-inherit :global(blockquote p::before),
	.prose-inherit :global(blockquote p::after),
	.prose-inherit :global(code::before),
	.prose-inherit :global(code::after) {
		content: none;
	}

	/*
		Inline code as the sources draw it: a tinted chip rather than bare bold
		text, which is what both Slack and GitHub show.
	*/
	.prose-inherit :global(:not(pre) > code) {
		padding: 0.1em 0.35em;
		border-radius: 0.25rem;
		font-weight: 400;
		font-size: 0.9em;
		background-color: color-mix(in oklab, var(--embed-foreground, currentColor) 8%, transparent);
	}

	.prose-inherit :global(blockquote) {
		font-style: normal;
		font-weight: inherit;
	}

	/*
		Wide content scrolls inside itself rather than widening the page (design §7).
		`.md-scroll` wraps every table; `pre` already scrolls but still needs a max
		width, or its own min-content pushes the column out on a phone.
	*/
	/*
		A readable line, whatever the column is doing.

		The feed column grew to 80rem so the cards could use a wide screen
		(`app.css`), and prose does not want that: a paragraph set 200 characters
		across is read by losing your place at the end of every line. So the words
		are capped and everything else on the card — the media grid, the thread,
		the fields, an app's frame — takes the full width, which is what the room
		was actually wanted for.
	*/
	.markdown-body {
		max-width: 78ch;
	}

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
