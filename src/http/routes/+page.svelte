<script lang="ts">
	// The dashboard. Everything visual lives in `$web`; this route is the mount
	// point and the title, so the shell can be component-tested without a server.
	import Shell from '$web/Shell.svelte';
	import { page } from '$app/state';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// What a notification pointed at (migration 021): the card or reply to scroll
	// to and light up once the timeline has it.
	const focus = $derived(page.url.searchParams.get('focus'));
</script>

<svelte:head><title>Agent Dashboard</title></svelte:head>

<Shell snapshot={data.snapshot} project={data.project} {focus} />
