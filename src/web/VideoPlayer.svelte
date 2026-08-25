<script lang="ts">
	/**
	 * The video player used on update cards and in the lightbox.
	 *
	 * Native `<video>` controls were the default and they are wrong for this
	 * content: every browser draws a different bar, none of them match a dark
	 * dashboard, and none can step a single frame — which is the one thing you
	 * want when an agent posts a ten-second capture of a rendering bug.
	 *
	 * `media-chrome` is a set of web components around a plain `<video>`, so the
	 * element itself, its `src`, its poster and `preload="none"` all behave exactly
	 * as they did before; only the controls change. It is loaded in the browser
	 * only: the custom elements register themselves on import, which needs a DOM.
	 *
	 * Until that import resolves the inner video keeps its native `controls`, so a
	 * player that never hydrates is still playable rather than a dead rectangle.
	 */
	import { onMount } from 'svelte';

	type Props = {
		/** The video to play, already a servable URL. */
		src: string;
		/** Poster frame from the derivative pipeline (design §6). */
		poster?: string | null;
		/** Accessible name, since the file name alone says little. */
		label: string;
		/** A single frame, in seconds. Screen captures here are 30fps. */
		frame?: number;
	};

	const { src, poster, label, frame = 1 / 30 }: Props = $props();

	let video = $state<HTMLVideoElement | null>(null);
	let enhanced = $state(false);

	onMount(async () => {
		await import('media-chrome');
		enhanced = true;
	});

	/**
	 * Nudge by exactly one frame.
	 *
	 * Pauses first: stepping while playing fights the playback clock and looks
	 * like nothing happened.
	 */
	function step(direction: 1 | -1) {
		if (!video) return;
		video.pause();
		const next = video.currentTime + direction * frame;
		video.currentTime = Math.min(Math.max(next, 0), video.duration || next);
	}
</script>

<media-controller class="player" style:--media-object-fit="contain">
	<!--
		No caption track exists to point at: the pipeline produces a poster and an
		h264 transcode (design §6), and nothing generates subtitles for an agent's
		screen recording.
	-->
	<!-- svelte-ignore a11y_media_has_caption -->
	<video
		bind:this={video}
		slot="media"
		{src}
		poster={poster ?? undefined}
		controls={!enhanced}
		playsinline
		preload="none"
		aria-label={label}
	></video>

	{#if poster}
		<media-poster-image slot="poster" src={poster}></media-poster-image>
	{/if}

	<media-loading-indicator slot="centered-chrome" noautohide></media-loading-indicator>

	<media-control-bar>
		<media-play-button></media-play-button>

		<!--
			Frame stepping is why this player exists. media-chrome has no button for
			it, so these are ours, styled to sit in its bar without looking bolted on.
		-->
		<button
			type="button"
			class="step"
			aria-label="Back one frame"
			title="Back one frame"
			onclick={() => step(-1)}
		>
			<svg viewBox="0 0 24 24" aria-hidden="true" width="18" height="18">
				<path fill="currentColor" d="M16 5v14l-9-7zM6 5h1.5v14H6z" />
			</svg>
		</button>
		<button
			type="button"
			class="step"
			aria-label="Forward one frame"
			title="Forward one frame"
			onclick={() => step(1)}
		>
			<svg viewBox="0 0 24 24" aria-hidden="true" width="18" height="18">
				<path fill="currentColor" d="M8 5v14l9-7zM16.5 5H18v14h-1.5z" />
			</svg>
		</button>

		<media-time-display showduration></media-time-display>
		<media-time-range></media-time-range>
		<media-mute-button></media-mute-button>
		<media-volume-range></media-volume-range>
		<media-playback-rate-button rates="0.25 0.5 1 1.5 2"></media-playback-rate-button>
		<media-fullscreen-button></media-fullscreen-button>
	</media-control-bar>
</media-controller>

<style>
	/*
		media-chrome themes entirely through CSS variables, so the player reads from
		the same tokens as the rest of the dashboard rather than shipping its own
		palette. Colours are given as literals here because these variables are
		consumed inside the components' shadow roots, where Tailwind's utilities do
		not reach.
	*/
	.player {
		--media-primary-color: rgb(244 244 245);
		--media-secondary-color: rgb(24 24 27 / 0.72);
		--media-control-hover-background: rgb(255 255 255 / 0.14);
		--media-range-track-height: 4px;
		--media-range-thumb-height: 12px;
		--media-range-thumb-width: 12px;
		--media-range-thumb-border-radius: 9999px;
		--media-control-height: 28px;
		--media-font-size: 12px;
		--media-text-color: rgb(244 244 245);

		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		background: #000;
	}

	.player video {
		width: 100%;
		height: 100%;
		object-fit: contain;
	}

	media-control-bar {
		/* Sits over the frame rather than stealing height from it. */
		--media-control-background: transparent;
		display: flex;
		align-items: center;
		gap: 1px;
		/*
			A deep scrim, because the content underneath is the worst case for
			legibility: gameplay capture with its own bright HUD burnt into the
			frame. At lower opacity the game's score overlay reads through the bar
			and looks like broken layout.
		*/
		background: linear-gradient(to top, rgb(0 0 0 / 0.92) 35%, rgb(0 0 0 / 0.55) 70%, transparent);
		padding: 1.25rem 0.25rem 0.125rem;
	}

	/*
		Everything except the scrub bar keeps its intrinsic width; only the range
		absorbs the slack. Without this the time display and the step buttons
		shrink into each other and the text overlaps the icons.
	*/
	media-control-bar > :not(media-time-range) {
		flex: 0 0 auto;
	}

	media-time-display {
		white-space: nowrap;
		padding-inline: 0.25rem;
	}

	media-time-range {
		flex: 1 1 auto;
		min-width: 2.5rem;
	}

	/* The volume slider is noise at card size; it appears on hover or focus. */
	media-volume-range {
		width: 0;
		overflow: hidden;
		transition: width 120ms ease;
	}

	media-control-bar:hover media-volume-range,
	media-volume-range:focus-within {
		width: 4.5rem;
	}

	.step {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: var(--media-control-height);
		color: var(--media-primary-color);
		background: transparent;
		border: 0;
		cursor: pointer;
	}

	.step:hover {
		background: var(--media-control-hover-background);
	}

	.step:focus-visible {
		outline: 2px solid rgb(244 244 245);
		outline-offset: -2px;
	}
</style>
