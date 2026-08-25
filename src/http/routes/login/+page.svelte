<script lang="ts">
	// The owner's front door. One password, no username: there is one owner and no
	// user table (design §8). Plain form, no `use:enhance` — logging in must work
	// before any JavaScript has loaded.
	import Theme from '$web/Theme.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<svelte:head><title>Sign in · Agent Dashboard</title></svelte:head>

<main class="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-6 py-16">
	<div class="flex items-baseline justify-between gap-4">
		<h1 class="text-2xl font-semibold tracking-tight">Agent Dashboard</h1>
		<Theme />
	</div>

	<form
		method="POST"
		class="flex flex-col gap-4 rounded-lg border border-border-subtle bg-surface-raised p-6"
	>
		<input type="hidden" name="redirectTo" value={data.redirectTo} />

		<label class="flex flex-col gap-2">
			<span class="text-sm text-content-muted">Owner password</span>
			<input
				type="password"
				name="password"
				autocomplete="current-password"
				required
				class="rounded border-border-subtle bg-surface text-content"
			/>
		</label>

		{#if form?.error}
			<p role="alert" class="text-sm text-content">{form.error}</p>
		{/if}

		{#if !data.configured}
			<p role="alert" class="text-sm text-content-muted">
				This deployment has no valid <code>ADMIN_PASSWORD_HASH</code> and
				<code>SESSION_SECRET</code>, so nobody can log in yet. See
				<code>.env.example</code>.
			</p>
		{/if}

		<button
			type="submit"
			class="rounded bg-accent px-3 py-2 font-medium text-surface hover:opacity-90"
		>
			Sign in
		</button>
	</form>

	<p class="text-sm text-content-muted">
		Agents do not log in. They connect over MCP at <code
			class="rounded bg-surface-raised px-1.5 py-0.5">/mcp</code
		> with a bearer token.
	</p>
</main>
