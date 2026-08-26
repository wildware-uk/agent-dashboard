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
	let controller = $state<HTMLElement | null>(null);
	let enhanced = $state(false);

	onMount(async () => {
		await import('media-chrome');
		enhanced = true;
	});

	/**
	 * Toggle fullscreen on the whole player, not the bare <video>.
	 *
	 * Fullscreening the controller keeps the controls in fullscreen; fullscreening
	 * the video element hands the browser's own chrome back, which is the thing
	 * this player exists to replace.
	 */
	async function toggleFullscreen() {
		if (!controller) return;
		try {
			if (document.fullscreenElement) await document.exitFullscreen();
			else await controller.requestFullscreen();
		} catch {
			// Denied (no user activation, or a browser that refuses): leave the
			// player as it was rather than throwing inside an event handler.
		}
	}

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

<!--
	Double click toggles fullscreen, which is what every video player on the web
	does and what its absence here was immediately noticed for. `ondblclick` on the
	controller catches it anywhere over the frame; media-chrome's gesture receiver
	keeps handling single click for play/pause.
-->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<media-controller
	bind:this={controller}
	class="player"
	style:--media-object-fit="contain"
	ondblclick={toggleFullscreen}
>
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
		palette. Colours are literals because these variables are consumed inside the
		components' shadow roots, where Tailwind's utilities do not reach.
	*/
	.player {
		--media-primary-color: rgb(244 244 245);
		--media-secondary-color: rgb(24 24 27 / 0.72);
		--media-control-hover-background: rgb(255 255 255 / 0.14);
		--media-range-track-height: 4px;
		--media-range-thumb-height: 12px;
		--media-range-thumb-width: 12px;
		--media-range-thumb-border-radius: 9999px;
		--media-control-height: 32px;
		--media-font-size: 12px;
		--media-text-color: rgb(244 244 245);

		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		background: #000;
		/*
			Controls adapt to the PLAYER's width, not the viewport's: the same player is
			full-width on a card and a small tile inside a media grid (design §7).
		*/
		container-type: inline-size;
	}

	.player video {
		width: 100%;
		height: 100%;
		object-fit: contain;
	}

	media-control-bar {
		--media-control-background: transparent;
		display: flex;
		align-items: center;
		gap: 1px;
		/*
			A deep scrim: the content underneath is the worst case for legibility,
			gameplay capture with its own bright HUD burnt into the frame.
		*/
		background: linear-gradient(to top, rgb(0 0 0 / 0.92) 35%, rgb(0 0 0 / 0.55) 70%, transparent);
		padding: 1.25rem 0.25rem 0.125rem;
	}

	/*
		Everything except the scrub bar keeps its intrinsic width; only the range
		absorbs the slack, so the time display and the step buttons never shrink into
		each other.
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

	/*
		A FIXED width, never animated.

		This slider used to expand from zero on hover, which pushed the playback-rate
		and fullscreen buttons right — so aiming at fullscreen moved it out from under
		the pointer before the click landed. Nothing in this bar may resize because a
		pointer approached it, and on a touch screen a hover-revealed control cannot
		be reached at all (design §7).
	*/
	media-volume-range {
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

	/*
		Touch. A thumb needs 44px; icon buttons sized for a mouse are not usable
		(design §7). Frame stepping goes entirely — it is a precision tool that a
		thumb cannot use well, and the room is better spent on the scrub bar.
	*/
	@media (pointer: coarse) {
		.player {
			--media-control-height: 44px;
			--media-range-thumb-height: 16px;
			--media-range-thumb-width: 16px;
		}

		.step {
			display: none;
		}

		media-control-bar {
			gap: 2px;
			padding: 1.5rem 0.375rem 0.25rem;
		}
	}

	/*
		Container queries LAST: they add no specificity, so source order is what makes
		them win over the base rules above.

		Below these widths the bar cannot hold everything without the scrub bar
		collapsing to nothing, so controls drop in order of how easily they are lived
		without. Playback rate and frame stepping are power tools; volume has the mute
		button as a fallback; play, position and fullscreen always stay.
	*/
	@container (max-width: 480px) {
		media-playback-rate-button,
		media-volume-range {
			display: none;
		}
	}

	@container (max-width: 360px) {
		.step {
			display: none;
		}
	}

	@container (max-width: 260px) {
		media-time-display,
		media-mute-button {
			display: none;
		}
	}
</style>
