/**
 * What a shared link unfurls to (design §7).
 *
 * A share URL gets pasted into Slack, iMessage, a PR description — and what
 * those show is decided entirely by meta tags on the page. Without them a link
 * to a card is a bare URL that says nothing, and the person it was sent to has
 * to open it to find out whether it was worth sending.
 *
 * Pure, and separate from the route, for two reasons. It is the one place that
 * decides *how much* of a private-ish card travels into somebody else's chat
 * window — the opening text and one image, never the whole body — and that is a
 * decision worth being able to read and test on its own. And an unfurl is
 * fetched by a crawler with no session, so everything referenced here has to be
 * an address that works unauthenticated, which means the share's own media
 * prefix and an absolute URL.
 */
import { excerpt } from './markdown';
import { mediaUrl } from './media';
import type { MediaView, SharedCardView } from './types';

/** The tags `/s/[token]` emits. Absent fields are tags that are not emitted. */
export type SharePreview = {
	title: string;
	description: string;
	url: string;
	/** Absolute, and reachable without a session. */
	image?: string;
	imageAlt?: string;
	imageWidth?: number;
	imageHeight?: number;
	/** A playable file, for the few readers that inline video. */
	video?: string;
	videoType?: string;
};

export type PreviewOptions = {
	/** The deployment's public origin, e.g. `https://agents.example.com`. */
	baseUrl: string;
	token: string;
};

/**
 * Build the preview for one shared card.
 *
 * The title is the card's own, or a sentence naming who posted it — never an
 * empty tag, because a preview with no title renders as the bare URL and undoes
 * the point of the exercise.
 */
export function sharePreview(card: SharedCardView, options: PreviewOptions): SharePreview {
	const origin = options.baseUrl.replace(/\/+$/, '');
	const prefix = `/s/${options.token}`;
	const absolute = (id: string, variant: Parameters<typeof mediaUrl>[1]) =>
		`${origin}${mediaUrl(id, variant, prefix)}`;

	const preview: SharePreview = {
		title: card.update.title ?? titleFor(card),
		// The body, or the title again if the body is empty: repeating it reads
		// better than a preview with a blank line where the summary goes.
		description: excerpt(card.update.body) || (card.update.title ?? ''),
		url: `${origin}${prefix}`
	};

	const ready = card.media.filter((item) => item.status === 'ready');
	const image = ready.find((item) => item.kind === 'image' && pick(item, 'thumb-1600', 'original'));
	const video = ready.find((item) => item.kind === 'video');

	// One image, the first. An unfurl shows a single picture, so choosing more
	// would be choosing which one gets ignored.
	const still = image ?? video;
	if (still) {
		const variant =
			still.kind === 'video' ? pick(still, 'poster') : pick(still, 'thumb-1600', 'original');
		if (variant) {
			preview.image = absolute(still.id, variant);
			preview.imageAlt = card.update.title ?? `Update from ${card.agentName}`;
			if (still.width !== null) preview.imageWidth = still.width;
			if (still.height !== null) preview.imageHeight = still.height;
		}
	}

	if (video) {
		const variant = pick(video, 'video', 'original');
		if (variant) {
			preview.video = absolute(video.id, variant);
			// The transcode is always mp4 (`src/media/derive.ts`); an original is
			// whatever was uploaded, and its stored mime is the honest answer.
			preview.videoType = variant === 'video' ? 'video/mp4' : video.mime;
		}
	}

	return preview;
}

/** The first of these variants the pipeline actually produced, or `null`. */
function pick(
	item: MediaView,
	...variants: MediaView['variants']
): MediaView['variants'][number] | null {
	return variants.find((variant) => item.variants.includes(variant)) ?? null;
}

/** A title for a card that has none: who said it, and where. */
function titleFor(card: SharedCardView): string {
	return card.projectName
		? `${card.agentName} in ${card.projectName}`
		: `An update from ${card.agentName}`;
}
