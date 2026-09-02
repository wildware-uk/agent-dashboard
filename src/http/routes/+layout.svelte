<script lang="ts">
	/**
	 * The root layout: the stylesheet, and nothing else.
	 *
	 * The favicon used to be imported here, which Vite inlined as a data URI into
	 * the head of every response. The icons are now stated in `src/app.html` as
	 * real files — several sizes, plus `/apple-touch-icon.png` at the root — so a
	 * phone adding this to its home screen has something to find. A second,
	 * inlined `rel="icon"` after those would be a duplicate that costs a kilobyte
	 * on every page.
	 */
	import './app.css';

	let { children } = $props();
</script>

{@render children()}
