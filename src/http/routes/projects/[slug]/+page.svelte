<script lang="ts">
	// One project's timeline. Same shell as `/`, so there is nothing here but the
	// title and the scope.
	import Shell from '$web/Shell.svelte';
	import { page } from '$app/state';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const project = $derived(
		data.snapshot.projects.find((candidate) => candidate.slug === data.project)
	);

	// What a notification pointed at (migration 021).
	const focus = $derived(page.url.searchParams.get('focus'));
</script>

<svelte:head><title>{project?.name ?? 'Project'} · Agent Dashboard</title></svelte:head>

<!--
	Keyed on the slug: navigating from one project to another is a different
	timeline and a different stream cursor, so the shell and its store are rebuilt
	rather than patched. Everything that happens *within* one project — a live
	arrival, a delete, a resync — is handled inside one store with no remount.
-->
{#key data.project}
	<Shell snapshot={data.snapshot} project={data.project} {focus} />
{/key}
