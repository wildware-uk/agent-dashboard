<script lang="ts">
	/**
	 * The name-hashed avatar (design §7). Colour and initials both come from
	 * `avatarFor`, so the same agent is the same badge on every card and in every
	 * session without storing a palette anywhere.
	 *
	 * Hue is the only thing that varies: lightness and contrast are fixed, so no
	 * agent name can produce a badge that is unreadable in one of the themes.
	 */
	import { avatarFor } from './avatar';

	let { name, class: className = '' }: { name: string; class?: string } = $props();

	const badge = $derived(avatarFor(name));
</script>

<!--
	Decorative, so `aria-hidden`: every card that shows a badge also shows the
	name beside it, and a screen reader announcing "RB, release bot" is worse than
	one that just reads the name.
-->
<span
	class="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white select-none {className}"
	style="background-color: hsl({badge.hue} 55% 42%)"
	data-hue={badge.hue}
	title={name}
	aria-hidden="true"
>
	{badge.initials}
</span>
