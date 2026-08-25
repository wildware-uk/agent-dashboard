<script lang="ts">
	import { onMount } from 'svelte';

	/**
	 * The theme toggle. Dark-first: `src/app.html` has already resolved the theme
	 * before first paint, so this only reads back what is on `<html>` and lets the
	 * owner override it. The choice is remembered; clearing it returns to the OS
	 * preference on next load.
	 */
	// Dark to match the authored document, then corrected once we are in the
	// browser and can see what app.html actually resolved. It cannot be a
	// `$derived` of the DOM: the server has no `document`, and reading it during
	// init would make the hydrated markup disagree with what was sent.
	let theme = $state<'dark' | 'light'>('dark');

	onMount(() => {
		theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
	});

	function set(next: 'dark' | 'light') {
		theme = next;
		const root = document.documentElement;
		root.dataset.theme = next;
		root.classList.toggle('dark', next === 'dark');
		try {
			localStorage.setItem('theme', next);
		} catch {
			// Private mode: the override lasts for this page only.
		}
	}
</script>

<button
	type="button"
	class="rounded border border-border-subtle px-2 py-1 text-sm text-content-muted hover:text-content"
	aria-label="Switch to {theme === 'dark' ? 'light' : 'dark'} theme"
	onclick={() => set(theme === 'dark' ? 'light' : 'dark')}
>
	{theme === 'dark' ? 'Dark' : 'Light'}
</button>
