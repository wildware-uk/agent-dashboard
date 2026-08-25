<script lang="ts">
	/**
	 * The right rail (design §7): live agents and open tasks.
	 *
	 * A deliberate placeholder. Presence is derived from heartbeats and tasks
	 * have their own slice, and inventing either here would mean the shell
	 * asserting things it cannot know — "no agents online" is a claim, not an
	 * empty state. So the region exists, is labelled, and says what will fill it.
	 */
</script>

<div class="flex flex-col gap-6 p-3 text-sm" data-rail>
	<section class="flex flex-col gap-2">
		<h2 class="text-xs font-semibold tracking-wide text-content-muted uppercase">Live agents</h2>
		<p class="text-content-muted">Presence arrives with the sessions slice.</p>
	</section>

	<section class="flex flex-col gap-2">
		<h2 class="text-xs font-semibold tracking-wide text-content-muted uppercase">Open tasks</h2>
		<p class="text-content-muted">Tasks arrive with the control-plane slice.</p>
	</section>
</div>
