<script lang="ts">
	/**
	 * The public page one share link resolves to (design §7, §8).
	 *
	 * A single card on an otherwise empty page. There is no shell, no sidebar and
	 * no navigation, because everything a visitor could click would want a session
	 * they do not have — and offering the dashboard to somebody who was sent one
	 * card is not what sharing meant.
	 */
	import SharedCard from '$web/SharedCard.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>{data.preview.title} · Agent Dashboard</title>
	<meta name="robots" content="noindex, nofollow" />

	<!--
		What this link unfurls to when it is pasted somewhere (design §7).

		`noindex` above and these are not in tension: the first tells a search
		engine not to keep the page, and these tell the chat app the link was
		pasted into what to draw. Only the opening of the body and one image travel
		— see `$web/preview.ts` for why that is the line.
	-->
	<meta name="description" content={data.preview.description} />
	<meta property="og:type" content="article" />
	<meta property="og:site_name" content="Agent Dashboard" />
	<meta property="og:title" content={data.preview.title} />
	<meta property="og:description" content={data.preview.description} />
	<meta property="og:url" content={data.preview.url} />
	<meta name="twitter:title" content={data.preview.title} />
	<meta name="twitter:description" content={data.preview.description} />

	{#if data.preview.image}
		<meta property="og:image" content={data.preview.image} />
		<meta property="og:image:alt" content={data.preview.imageAlt} />
		{#if data.preview.imageWidth}
			<meta property="og:image:width" content={String(data.preview.imageWidth)} />
		{/if}
		{#if data.preview.imageHeight}
			<meta property="og:image:height" content={String(data.preview.imageHeight)} />
		{/if}
		<meta name="twitter:card" content="summary_large_image" />
		<meta name="twitter:image" content={data.preview.image} />
	{:else}
		<!-- No picture on this card, so a big empty image box would be worse. -->
		<meta name="twitter:card" content="summary" />
	{/if}

	{#if data.preview.video}
		<meta property="og:video" content={data.preview.video} />
		<meta property="og:video:secure_url" content={data.preview.video} />
		<meta property="og:video:type" content={data.preview.videoType} />
	{/if}
</svelte:head>

<main class="min-h-dvh bg-surface px-3 py-8 text-content sm:px-4">
	<div class="mx-auto flex max-w-3xl flex-col gap-4">
		<SharedCard card={data.card} mediaPrefix="/s/{data.token}" />

		<!--
			Says what this page is, and stops short of inviting a visitor to log in:
			they were sent one card, and a sign-in link on it would read as an offer
			they cannot take up.
		-->
		<p class="px-1 text-xs text-content-muted">
			Shared from an Agent Dashboard. Only this update is visible, and the link can be switched off
			by whoever sent it.
		</p>
	</div>
</main>
