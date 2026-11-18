<script lang="ts">
	/**
	 * One embed: something shown in the style of where it came from
	 * (migration 027, migration 028).
	 *
	 * The owner asked for agents to be able to portray a thing — a Slack message,
	 * a GitHub comment, a Jira ticket, a Confluence page — rather than paste it as
	 * flat text, and then for those to look *identical* to their sources. So this
	 * component does not know what Slack is. It draws whatever blocks the look
	 * names, at whatever sizes and in whatever colours the look asked for, and
	 * `slack-message` is nothing but a row in a table.
	 *
	 * What migration 028 added is the reason that can be faithful. A palette alone
	 * cannot make a card look like Slack: a Slack message is a rounded-square
	 * avatar with the name and the time on one line and reaction pills under the
	 * text, while a GitHub comment is a circular avatar in a tinted bar above a
	 * white body. Those are layout facts, so a look can now name them — the avatar
	 * shape and size, whether the header is one line or two, whether it is a bar,
	 * the chip style, the field layout, the frame's border, stripe and air.
	 *
	 * **Every value here is still text.** The spec names blocks, sizes and shapes
	 * from closed lists and colours that the server has already checked are hex
	 * literals (`$domain/embeds.ts`), and each one is bound into a text node, a
	 * validated `src`/`href`, or a class this file wrote. There is no `{@html}`,
	 * and no string from an agent ever becomes a class name or a declaration —
	 * which is what makes "agents may style an embed" safe to have said yes to.
	 *
	 * The palette arrives as `--embed-*` custom properties on the card, so a look
	 * that names no background inherits the dashboard's own rather than being
	 * forced onto white — and one that names a white background gets white,
	 * whichever theme the owner is in.
	 */
	import EmbedMark from './EmbedMark.svelte';
	import Markdown from './Markdown.svelte';
	import {
		bodyIndent,
		chipsOf,
		fontClass,
		frameClass,
		imageSrc,
		isDarkCard,
		link,
		resolveBlocks,
		resolveChrome,
		resolveMark,
		themeStyle,
		withSource
	} from './embeds';
	import { highlightIn, languageClass } from './highlight';
	import type { EmbedView } from './types';

	let { embed }: { embed: EmbedView } = $props();

	// `source_url` is a column rather than something the poster typed, so it is
	// offered to the look under that name before anything is filled in.
	const data = $derived(withSource(embed.data, embed.sourceUrl));
	const blocks = $derived(resolveBlocks(embed.spec, data));
	const chrome = $derived(resolveChrome(embed.spec, data));
	// The source's own mark, small in the corner (migration 029). A card with no
	// badge still needs to say where it came from — that is the whole of what the
	// owner was missing when four white cards looked like four white cards.
	const brand = $derived(resolveMark(embed.spec, data));
	// Where it came from, if the poster said. The badge becomes the link, so a
	// source_url is never a column nobody reads.
	const source = $derived(embed.sourceUrl ? link(embed.sourceUrl) : null);
	const style = $derived(themeStyle(embed.spec.theme));
	const font = $derived(fontClass(embed.spec.theme));
	const frame = $derived(frameClass(embed.spec.frame));
	// Only the code palette reads this: the syntax hues are chosen for a
	// background, and a look declares its own (`app.css`).
	const dark = $derived(isDarkCard(embed.spec.theme));

	/** The card itself, so its own `code` blocks can be coloured. */
	let card = $state<HTMLElement | null>(null);

	/**
	 * Colour this card's code blocks (design §7).
	 *
	 * An embed's `code` block is not markdown — it is a block the look named — so
	 * it is not reached by the pass inside `Markdown.svelte`. Same highlighter,
	 * same rule for finding a block, one more caller.
	 */
	$effect(() => {
		// Reading `blocks` is what makes this re-run when the card's contents
		// change; there is nothing to colour when it has none.
		if (blocks.length > 0) void highlightIn(card);
	});
	// Slack lines its text up under the name rather than under the avatar. The
	// distance comes from the header's own avatar size, so the two cannot
	// disagree; `null` when the look did not ask, or there is no avatar to clear.
	const indent = $derived(bodyIndent(embed.spec, blocks));
</script>

{#if blocks.length > 0}
	<article
		bind:this={card}
		data-embed={embed.id}
		data-embed-type={embed.type}
		{style}
		class="{frame} {font} {dark ? 'embed-dark' : ''}"
	>
		{#if brand}
			<!--
				Top right, floating over the card rather than in its flow: every look
				gets one without any of them having to leave a space for it, and it
				never pushes the content a source actually leads with out of place.
			-->
			<div class="embed-brand" data-embed-mark={brand.kind === 'drawn' ? brand.mark : 'image'}>
				{#if brand.kind === 'drawn'}
					<EmbedMark mark={brand.mark} label={brand.label} />
				{:else}
					<!-- eslint-disable svelte/no-navigation-without-resolve -->
					<img
						src={brand.src}
						alt={brand.label}
						referrerpolicy="no-referrer"
						loading="lazy"
						decoding="async"
						class="size-3.5 rounded-[2px] object-contain"
					/>
					<!-- eslint-enable svelte/no-navigation-without-resolve -->
				{/if}
			</div>
		{/if}

		{#if chrome}
			<div class="embed-chrome">
				{#if chrome.icon}<span aria-hidden="true">{chrome.icon}</span>{/if}
				{#if chrome.label}
					{#if source}
						<!--
							An agent-supplied link, opened with the opener and the referrer
							cut. `link()` has refused anything that is not http or https, as
							has the server.
						-->
						<!-- eslint-disable svelte/no-navigation-without-resolve -->
						<a
							href={source}
							target="_blank"
							rel="noreferrer noopener"
							class="font-medium underline-offset-2 hover:underline">{chrome.label}</a
						>
						<!-- eslint-enable svelte/no-navigation-without-resolve -->
					{:else}
						<span class="font-medium">{chrome.label}</span>
					{/if}
				{/if}
			</div>
		{/if}

		<div class="embed-body" style={indent ? `--embed-indent: ${indent}` : undefined}>
			{#each blocks as block, index (index)}
				{#if block.type === 'header'}
					<!--
						A header is a bar or a row, and one line or two. Slack is a row with
						the name and the time on one line; a GitHub comment is a bar with a
						circular avatar in it. Both fall out of these two flags.
					-->
					<div
						class="embed-header embed-avatar-{block.shape ?? 'rounded'} embed-header-{block.size ??
							'md'} {block.bar ? 'embed-header-bar' : ''}"
					>
						{#if block.avatar}
							{@const src = imageSrc(block.avatar)}
							{#if src}
								<!--
									A media address, not a route: root-relative on purpose, exactly
									as the media grid's are, so the same string means the same thing
									on every page. An external https URL passes through as given,
									with no referrer, because an agent quoting somebody's avatar has
									a URL and not an upload.
								-->
								<!-- eslint-disable svelte/no-navigation-without-resolve -->
								<img
									{src}
									alt=""
									referrerpolicy="no-referrer"
									loading="lazy"
									decoding="async"
									class="embed-avatar"
								/>
								<!-- eslint-enable svelte/no-navigation-without-resolve -->
							{/if}
						{/if}

						{#if (block.layout ?? 'stacked') === 'inline'}
							<!--
								Slack's line: the name in bold, then everything else beside it in
								small grey. It wraps rather than truncates, because a long channel
								name on a phone should go to a second line rather than push the
								timestamp off the card.
							-->
							<div class="embed-header-line">
								{#if block.title}<span class="embed-name">{block.title}</span>{/if}
								{#if block.subtitle}<span class="embed-muted">{block.subtitle}</span>{/if}
								{#if block.meta}<span class="embed-muted">{block.meta}</span>{/if}
							</div>
						{:else}
							<div class="embed-header-stack">
								{#if block.title}<span class="embed-name">{block.title}</span>{/if}
								{#if block.subtitle}<span class="embed-muted text-xs">{block.subtitle}</span>{/if}
							</div>
							{#if block.meta}<span class="embed-muted shrink-0 text-xs">{block.meta}</span>{/if}
						{/if}
					</div>
				{:else if block.type === 'heading'}
					{#if block.level === 2}
						<h4 class="embed-heading embed-heading-2">{block.value}</h4>
					{:else}
						<h3 class="embed-heading embed-heading-1">{block.value}</h3>
					{/if}
				{:else if block.type === 'text'}
					<p
						class="embed-size-{block.size ?? 'md'} embed-tone-{block.tone ??
							'normal'} break-words whitespace-pre-wrap"
					>
						{block.value}
					</p>
				{:else if block.type === 'markdown'}
					<div class="embed-size-{block.size ?? 'md'}">
						<Markdown body={block.value} inherit />
					</div>
				{:else if block.type === 'code'}
					<!--
						The language goes on the `code` element as a markdown fence's does,
						so the one highlighter finds this block by the same rule
						(`./highlight.ts`) rather than there being a second path to keep in
						step. `languageClass` is what stops an agent's word becoming an
						arbitrary class on the owner's page.
					-->
					<pre class="embed-code max-w-full overflow-x-auto rounded p-2 text-xs"><code
							class={languageClass(block.language)}>{block.value}</code
						></pre>
				{:else if block.type === 'quote'}
					<blockquote class="embed-quote border-l-2 pl-2.5 text-sm whitespace-pre-wrap">
						{block.value}
					</blockquote>
				{:else if block.type === 'fields'}
					<dl class="embed-fields embed-fields-{block.layout ?? 'rows'}">
						{#each block.items as item, row (row)}
							<dt class="embed-muted">{item.label}</dt>
							<dd class="break-words">{item.value}</dd>
						{/each}
					</dl>
				{:else if block.type === 'chips'}
					<ul class="flex flex-wrap gap-1.5">
						{#each chipsOf(block.value) as chip, at (at)}
							<li class="embed-chip embed-chip-{block.style ?? 'tag'}">{chip}</li>
						{/each}
					</ul>
				{:else if block.type === 'image'}
					{@const src = imageSrc(block.value)}
					{#if src}
						<!-- eslint-disable svelte/no-navigation-without-resolve -->
						<img
							{src}
							alt={block.alt ?? ''}
							referrerpolicy="no-referrer"
							loading="lazy"
							decoding="async"
							class="embed-image max-h-80 w-full rounded object-contain"
						/>
						<!-- eslint-enable svelte/no-navigation-without-resolve -->
					{/if}
				{:else if block.type === 'divider'}
					<hr class="embed-rule" />
				{:else if block.type === 'footer'}
					<div class="embed-footer">
						{#if block.url}
							<!--
								An agent-supplied link, so it opens in a new tab with the opener
								and the referrer both cut. `link()` has already refused anything
								that is not http or https, as has the server.
							-->
							<!-- eslint-disable svelte/no-navigation-without-resolve -->
							<a
								href={block.url}
								target="_blank"
								rel="noreferrer noopener"
								class="embed-link underline-offset-2 hover:underline">{block.value ?? block.url}</a
							>
							<!-- eslint-enable svelte/no-navigation-without-resolve -->
						{:else}
							{block.value}
						{/if}
					</div>
				{/if}
			{/each}
		</div>
	</article>
{/if}

<style>
	/*
		The palette an embed is drawn in.

		Every value comes from a `--embed-*` custom property set on the card by
		`themeStyle`, and every one has a fallback to the dashboard's own token —
		so a look that names three colours gets three colours and inherits the
		rest, rather than having to state a whole theme to change an accent.
	*/
	.embed {
		position: relative;
		overflow: hidden;
		border: 1px solid var(--embed-border, var(--color-border-subtle));
		background-color: var(--embed-background, var(--color-surface-raised));
		color: var(--embed-foreground, var(--color-content));
		border-radius: var(--embed-radius, 0.5rem);
		/* Source cards are dense; the dashboard's own type scale is not. */
		line-height: 1.46;
	}

	/* A source with no card edge of its own — a quoted page, say. */
	.embed-borderless {
		border-color: transparent;
	}

	/*
		The accent stripe down the left edge. Off by default since migration 028:
		most sources do not have one, and a Slack message certainly does not.
	*/
	.embed-striped .embed-body {
		border-left: 3px solid var(--embed-accent, var(--color-border-subtle));
	}

	.embed-body {
		display: flex;
		flex-direction: column;
	}

	/*
		The source's mark.

		Absolutely placed so that adding one changes no other card's layout, and
		held slightly back so it names the source without competing with it — the
		way a watermark on a quotation does. It brightens on hover because on a card
		whose source is linked it is worth noticing that it is.
	*/
	.embed-brand {
		position: absolute;
		top: 0.5rem;
		right: 0.5rem;
		z-index: 1;
		display: flex;
		opacity: 0.75;
		color: var(--embed-muted, var(--color-content-muted));
	}

	.embed:hover .embed-brand {
		opacity: 1;
	}

	/*
		Three densities. The custom properties are how a full-bleed header bar
		cancels the padding it sits inside without hardcoding a number twice.
	*/
	.embed-pad-tight .embed-body {
		--embed-pad-y: 0.5rem;
		--embed-pad-x: 0.625rem;
		gap: 0.375rem;
	}

	.embed-pad-normal .embed-body {
		--embed-pad-y: 0.625rem;
		--embed-pad-x: 0.75rem;
		gap: 0.5rem;
	}

	.embed-pad-roomy .embed-body {
		--embed-pad-y: 0.75rem;
		--embed-pad-x: 1rem;
		gap: 0.625rem;
	}

	.embed-body {
		gap: 0.5rem;
		padding: var(--embed-pad-y, 0.625rem) var(--embed-pad-x, 0.75rem);
	}

	/*
		Slack's alignment: everything below the header lines up under the name, not
		under the avatar. `--embed-indent` is set only when the look asked for it
		and there is an avatar to clear, so this is `0` everywhere else.
	*/
	.embed-body > :global(*:not(.embed-header)) {
		padding-left: var(--embed-indent, 0);
	}

	/* The badge along the top, in the source's own colour. */
	.embed-chrome {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.375rem 0.75rem;
		font-size: 0.75rem;
		color: var(--embed-accent, var(--color-content-muted));
		background-color: color-mix(
			in oklab,
			var(--embed-accent, var(--color-content-muted)) 10%,
			transparent
		);
		border-bottom: 1px solid var(--embed-border, var(--color-border-subtle));
	}

	/*
		A header is a row of an avatar and some words.

		`embed-header-bar` is the GitHub comment shape: the header is a tinted band
		with its own edge, full-bleed against the card, rather than the first line
		of the body. It is tinted from the foreground rather than the accent,
		because that band is grey on GitHub and on Jira alike.
	*/
	.embed-header {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		min-width: 0;
	}

	.embed-header-bar {
		align-items: center;
		margin: calc(-1 * var(--embed-pad-y, 0.625rem)) calc(-1 * var(--embed-pad-x, 0.75rem)) 0;
		padding: 0.5rem var(--embed-pad-x, 0.75rem);
		background-color: color-mix(
			in oklab,
			var(--embed-foreground, var(--color-content)) 5%,
			transparent
		);
		border-bottom: 1px solid var(--embed-border, var(--color-border-subtle));
	}

	/* One line — Slack's — with the name first and everything else beside it. */
	.embed-header-line {
		display: flex;
		flex: 1;
		min-width: 0;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.5rem;
		font-size: 0.8125rem;
	}

	.embed-header-stack {
		display: flex;
		flex: 1;
		min-width: 0;
		flex-direction: column;
	}

	.embed-name {
		font-weight: 700;
		color: var(--embed-foreground, var(--color-content));
		word-break: break-word;
	}

	/*
		Avatar size and shape.

		Slack's is 36px with a 4px corner, GitHub's is a 20px circle in the bar, and
		a link preview's thumbnail is larger and square. Three sizes and three
		shapes cover every source anybody has asked for.
	*/
	.embed-avatar {
		flex-shrink: 0;
		object-fit: cover;
	}

	.embed-header-sm .embed-avatar {
		width: 1.25rem;
		height: 1.25rem;
	}

	.embed-header-md .embed-avatar {
		width: 2.25rem;
		height: 2.25rem;
	}

	.embed-header-lg .embed-avatar {
		width: 3rem;
		height: 3rem;
	}

	.embed-avatar-circle .embed-avatar {
		border-radius: 9999px;
	}

	.embed-avatar-rounded .embed-avatar {
		border-radius: 0.25rem;
	}

	.embed-avatar-square .embed-avatar {
		border-radius: 0;
	}

	/* A page title, for a source that leads with one. */
	.embed-heading {
		color: var(--embed-foreground, var(--color-content));
		font-weight: 600;
		line-height: 1.25;
		word-break: break-word;
	}

	.embed-heading-1 {
		font-size: 1.25rem;
	}

	.embed-heading-2 {
		font-size: 1rem;
	}

	/*
		Body type. `md` is 15px on purpose: that is Slack's and GitHub's message
		size, and the dashboard's own 14px reads as a quotation of a smaller thing.
	*/
	.embed-size-sm {
		font-size: 0.75rem;
	}

	.embed-size-md {
		font-size: 0.9375rem;
	}

	.embed-size-lg {
		font-size: 1rem;
	}

	.embed-tone-normal {
		color: var(--embed-foreground, var(--color-content));
	}

	.embed-tone-muted,
	.embed-muted {
		color: var(--embed-muted, var(--color-content-muted));
	}

	.embed-tone-accent {
		color: var(--embed-accent, var(--color-accent));
		font-weight: 600;
	}

	.embed-footer {
		font-size: 0.75rem;
		color: var(--embed-muted, var(--color-content-muted));
	}

	.embed-link {
		color: var(--embed-accent, var(--color-accent));
	}

	.embed-quote {
		border-color: var(--embed-border, var(--color-border-subtle));
		color: var(--embed-muted, var(--color-content-muted));
	}

	.embed-rule {
		border-color: var(--embed-border, var(--color-border-subtle));
	}

	/*
		Fields: a ticket's sidebar. `rows` is the label/value table Jira shows;
		`inline` is the run-on line a compact card wants.
	*/
	.embed-fields {
		font-size: 0.8125rem;
	}

	.embed-fields-rows {
		display: grid;
		grid-template-columns: auto 1fr;
		column-gap: 0.75rem;
		row-gap: 0.25rem;
	}

	.embed-fields-inline {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 0.75rem;
	}

	.embed-fields-inline dt,
	.embed-fields-inline dd {
		display: inline;
	}

	/*
		Code is tinted from the foreground rather than given a colour of its own, so
		it sits correctly on a white Slack card and on a dark one without the look
		having to say anything about either.
	*/
	.embed-code {
		background-color: color-mix(
			in oklab,
			var(--embed-foreground, var(--color-content)) 7%,
			transparent
		);
	}

	/*
		Three chip shapes, because the sources genuinely differ.

		`pill` is a Slack reaction: an outlined capsule tinted with the accent.
		`lozenge` is a Jira status: small, uppercase, filled, barely rounded.
		`tag` is a GitHub label: a plain outlined capsule.
	*/
	.embed-chip {
		display: inline-flex;
		align-items: center;
		font-size: 0.75rem;
		line-height: 1.2;
	}

	/*
		Tinted from the foreground rather than the accent, which is what a Slack
		reaction actually is: a neutral outlined capsule on the message background.
		Tinting it with the brand colour turned every reaction purple, which was the
		single most obviously-not-Slack thing on the card.
	*/
	.embed-chip-pill {
		gap: 0.25rem;
		padding: 0.125rem 0.5rem;
		border-radius: 9999px;
		border: 1px solid color-mix(in oklab, var(--embed-foreground, currentColor) 20%, transparent);
		background-color: color-mix(in oklab, var(--embed-foreground, currentColor) 5%, transparent);
		color: var(--embed-foreground, var(--color-content));
	}

	.embed-chip-lozenge {
		padding: 0.0625rem 0.375rem;
		border-radius: 0.1875rem;
		font-size: 0.6875rem;
		font-weight: 700;
		letter-spacing: 0.03em;
		text-transform: uppercase;
		background-color: color-mix(in oklab, var(--embed-accent, currentColor) 16%, transparent);
		color: var(--embed-accent, var(--color-content));
	}

	.embed-chip-tag {
		padding: 0.0625rem 0.5rem;
		border-radius: 9999px;
		border: 1px solid var(--embed-border, var(--color-border-subtle));
		color: var(--embed-muted, var(--color-content-muted));
	}
</style>
