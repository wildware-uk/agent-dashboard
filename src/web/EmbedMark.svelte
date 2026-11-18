<script lang="ts">
	/**
	 * A source's brand mark (migration 029).
	 *
	 * The owner asked for embeds to carry "the slack/github icon etc", and they
	 * were right: a dashboard is a wall of quotations from four different places,
	 * so the first thing you need from a card is where it came from. A real Slack
	 * message carries no Slack logo because you are already in Slack; a quotation
	 * of one, on somebody else's page, is a different problem.
	 *
	 * **Drawn here, never fetched.** Each mark is inline SVG this file owns, which
	 * settles three things at once: no request to a third party can leak the
	 * owner's address or the fact that they are reading this; nothing breaks when
	 * somebody's CDN does; and a look carries a *name* from a closed list rather
	 * than anything that could become markup. A source we ship no mark for uses
	 * `chrome.image` instead, which is an ordinary uploaded picture.
	 *
	 * The marks are each brand's own, used to say "this came from there" and
	 * nothing else — the ordinary way one names a thing one is quoting.
	 */
	import type { EmbedMark } from './types';

	let {
		mark,
		/** Pixel size of the square the mark is drawn in. */
		size = 14,
		/** The name of the source, for anybody who cannot see the picture. */
		label
	}: { mark: EmbedMark; size?: number; label: string } = $props();
</script>

<svg
	width={size}
	height={size}
	viewBox="0 0 16 16"
	role="img"
	aria-label={label}
	class="embed-mark shrink-0"
>
	{#if mark === 'slack'}
		<!--
			Four pairs of rounded bars in the four Slack colours, rotationally
			symmetric: the mark is geometry rather than a drawing, which is why it
			can be stated honestly at this size.
		-->
		<path
			fill="#36C5F0"
			d="M5.1 9.8a1.4 1.4 0 1 1-1.4-1.4h1.4zm.7 0a1.4 1.4 0 0 1 2.8 0v3.5a1.4 1.4 0 0 1-2.8 0z"
		/>
		<path
			fill="#2EB67D"
			d="M7.2 4.2a1.4 1.4 0 1 1 1.4-1.4v1.4zm0 .7a1.4 1.4 0 0 1 0 2.8H3.7a1.4 1.4 0 0 1 0-2.8z"
		/>
		<path
			fill="#ECB22E"
			d="M11.5 6.3a1.4 1.4 0 1 1 1.4 1.4h-1.4zm-.7 0a1.4 1.4 0 0 1-2.8 0V2.8a1.4 1.4 0 0 1 2.8 0z"
		/>
		<path
			fill="#E01E5A"
			d="M9.4 11.8a1.4 1.4 0 1 1-1.4 1.4v-1.4zm0-.7a1.4 1.4 0 0 1 0-2.8h3.5a1.4 1.4 0 0 1 0 2.8z"
		/>
	{:else if mark === 'github'}
		<!-- The octicon mark, in the card's own foreground so it reads on any card. -->
		<path
			fill="currentColor"
			d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8"
		/>
	{:else if mark === 'gitlab'}
		<path fill="#FC6D26" d="m8 15-2.1-6.4H2.6l1.1-3.3.9-2.8.9 2.8h5l.9-2.8.9 2.8 1.1 3.3h-3.3z" />
	{:else if mark === 'jira'}
		<!--
			Two chevrons pointing up and to the right, the smaller nested inside the
			larger: Jira's mark reduced to the two strokes that make it recognisable
			at fourteen pixels.
		-->
		<path fill="#2684FF" d="M8.6 1 15 7.4l-2.1 2.1-4.3-4.3-4.3 4.3L2.2 7.4z" />
		<path fill="#0052CC" d="M8.6 6.5 15 12.9 12.9 15 8.6 10.7 4.3 15l-2.1-2.1z" opacity=".85" />
	{:else if mark === 'confluence'}
		<!--
			Two thick ribbons, one in each half of the square, curving opposite ways
			and point-symmetric about the centre — stacked rather than crossed, which
			is the difference between Confluence's mark and a blue X. Stroked rather
			than filled: at fourteen pixels the weight of the band is most of what
			makes it readable.
		-->
		<path
			fill="none"
			stroke="#2684FF"
			stroke-width="3"
			stroke-linecap="round"
			d="M1.9 6.9C4.1 3.4 6.7 2.8 9.2 4.2c1.6.9 2.9 2 4.9 3"
		/>
		<path
			fill="none"
			stroke="#0052CC"
			stroke-width="3"
			stroke-linecap="round"
			d="M14.1 9.1c-2.2 3.5-4.8 4.1-7.3 2.7-1.6-.9-2.9-2-4.9-3"
		/>
	{:else if mark === 'linear'}
		<path
			fill="#5E6AD2"
			d="M.6 9.6 6.4 15.4A8 8 0 0 1 .6 9.6M.1 6.9l9 9a8 8 0 0 0 1.7-.6L.7 5.2a8 8 0 0 0-.6 1.7m1.4-3.3 10.9 11a8 8 0 0 0 1.3-1.1L2.6 2.3a8 8 0 0 0-1.1 1.3M3.8 1.4 14.6 12.2A8 8 0 0 0 3.8 1.4"
		/>
	{:else if mark === 'notion'}
		<path
			fill="currentColor"
			d="M2 2.6 11.4 2c1.2-.1 1.5 0 2.2.5l2 1.4c.5.4.7.5.7.9v9.4c0 .7-.3 1.1-1.2 1.2l-10.9.7c-.7 0-1-.1-1.4-.5L1.4 14c-.3-.4-.4-.7-.4-1.1V3.6c0-.6.3-1 1-1zm1.2 1.5c-.3.2-.3.3-.1.5l1.4 1c.2.1.4.1.6 0l6.9-.4c.3 0 .1-.2 0-.3L10.5 3.9c-.2-.2-.5-.3-1-.3zm2 10.6 7.5-.4c.2 0 .1-.2.1-.3l-.1-8c0-.2 0-.3-.2-.3l-7.5.4c-.2 0-.3.1-.3.3v8c0 .2.1.3.5.3"
		/>
	{:else if mark === 'figma'}
		<path fill="#0ACF83" d="M5.3 15.6a2.6 2.6 0 0 0 2.6-2.6v-2.6H5.3a2.6 2.6 0 1 0 0 5.2" />
		<path fill="#A259FF" d="M2.7 8a2.6 2.6 0 0 1 2.6-2.6h2.6v5.2H5.3A2.6 2.6 0 0 1 2.7 8" />
		<path fill="#F24E1E" d="M2.7 3a2.6 2.6 0 0 1 2.6-2.6h2.6v5.2H5.3A2.6 2.6 0 0 1 2.7 3" />
		<path fill="#FF7262" d="M7.9.4h2.6a2.6 2.6 0 1 1 0 5.2H7.9z" />
		<path fill="#1ABCFE" d="M13.1 8a2.6 2.6 0 1 1-5.2 0 2.6 2.6 0 0 1 5.2 0" />
	{:else}
		<!-- The fallback: a plain chain, for a source with no mark of its own. -->
		<path
			fill="currentColor"
			d="M6.4 9.6a.75.75 0 0 0 1.06 0l3.3-3.3a1.75 1.75 0 1 1 2.48 2.47l-1.6 1.6a.75.75 0 0 0 1.06 1.06l1.6-1.6a3.25 3.25 0 0 0-4.6-4.6l-3.3 3.3a.75.75 0 0 0 0 1.07m3.2-3.2a.75.75 0 0 0-1.06 0l-3.3 3.3a1.75 1.75 0 1 1-2.48-2.47l1.6-1.6A.75.75 0 0 0 3.3 4.57l-1.6 1.6a3.25 3.25 0 0 0 4.6 4.6l3.3-3.3a.75.75 0 0 0 0-1.07"
		/>
	{/if}
</svg>

<style>
	.embed-mark {
		display: block;
	}
</style>
