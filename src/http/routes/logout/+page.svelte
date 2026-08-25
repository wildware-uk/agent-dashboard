<script lang="ts">
	// A POST, not a link: a GET that signs you out is a link any site can make
	// your browser follow.
	import { resolve } from '$app/paths';
</script>

<svelte:head><title>Sign out · Agent Dashboard</title></svelte:head>

<main class="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-6 py-16">
	<h1 class="text-2xl font-semibold tracking-tight">Sign out</h1>
	<form method="POST" class="flex items-center gap-4">
		<button
			type="submit"
			class="rounded bg-accent px-3 py-2 font-medium text-surface hover:opacity-90"
		>
			Sign out
		</button>
		<a class="text-sm text-content-muted underline" href={resolve('/')}>Stay signed in</a>
	</form>
</main>
