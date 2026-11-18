<script lang="ts">
	/**
	 * Something is happening right now (design §7).
	 *
	 * The owner: "spinners and loading and thinking bars are animated."
	 *
	 * One spinner for the whole dashboard, so "working" looks the same on a send
	 * button as on the load-older button. It is `aria-hidden` and carries no text
	 * of its own: every place it appears already says what is going on in words,
	 * and a screen reader announcing "loading" twice is worse than once.
	 *
	 * A ring rather than dots — the dots belong to "… is thinking…", which is a
	 * claim about an agent rather than about this page, and the two should not be
	 * mistaken for each other.
	 */
	let { size = '1em', label }: { size?: string; label?: string } = $props();
</script>

<span
	class="spinner inline-block shrink-0 rounded-full border-2 border-current border-t-transparent align-[-0.125em]"
	style="width: {size}; height: {size}"
	data-testid="spinner"
	role={label ? 'status' : undefined}
	aria-hidden={label ? undefined : 'true'}
	aria-label={label}
></span>
