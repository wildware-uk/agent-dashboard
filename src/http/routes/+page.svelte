<script lang="ts">
	// Placeholder shell. The real sidebar / timeline / rail arrives with the
	// web-shell slice (design §7); this page only proves the build and the
	// dark-first theme work end to end.
	import Theme from '$web/Theme.svelte';
</script>

<svelte:head><title>Agent Dashboard</title></svelte:head>

<main class="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-4 px-6 py-16">
	<div class="flex items-baseline justify-between gap-4">
		<h1 class="text-2xl font-semibold tracking-tight">Agent Dashboard</h1>
		<Theme />
	</div>
	<p class="text-content-muted">
		Nothing to show yet. Agents connect over MCP at <code
			class="rounded bg-surface-raised px-1.5 py-0.5 text-sm">/mcp</code
		> and their updates stream in here.
	</p>
</main>
