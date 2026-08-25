<script lang="ts">
	// The dashboard. Everything visual lives in `$web`; this route is the mount
	// point and the title, so the shell can be component-tested without a server.
	import Shell from '$web/Shell.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head><title>Agent Dashboard</title></svelte:head>

<Shell snapshot={data.snapshot} project={data.project} />
