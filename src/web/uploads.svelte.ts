/**
 * Images waiting to go out with a message (migration 016).
 *
 * The box holds ids, not bytes. Each file is uploaded the moment it is chosen —
 * its own request, resolved before anything is posted — so a slow picture never
 * holds up the words, a failed one is reported while the owner is still looking
 * at the box, and the message that finally posts carries ids the server has
 * already accepted.
 *
 * Three ways in, because they are three different habits and a picker that only
 * answers one of them is a picker people work around: the file chooser, a paste,
 * and a drop. All three end here.
 */
import type { MediaView } from './types';
import type { OwnerActions } from './actions';
import { actionMessage } from './actions';

/** One attachment, from chosen to uploaded. */
export type Attachment =
	| { state: 'uploading'; key: string; name: string; preview: string | null }
	| { state: 'done'; key: string; name: string; preview: string | null; media: MediaView };

/** What a picture may be. The server decides for real; this is what the dialog offers. */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

/** How many one message may carry, matching the server's per-update cap. */
export const ATTACHMENT_MAX = 24;

export class Uploads {
	items = $state<Attachment[]>([]);
	/** What went wrong with the last attempt, for the box to show. */
	error = $state<string | null>(null);

	private next = 0;

	constructor(private readonly actions: Pick<OwnerActions, 'uploadMedia'>) {}

	/** The ids to send with the message. Only the ones the server has taken. */
	get ids(): string[] {
		return this.items
			.filter((item): item is Extract<Attachment, { state: 'done' }> => item.state === 'done')
			.map((item) => item.media.id);
	}

	/** Whether anything is still in flight, so a send can wait rather than lose it. */
	get busy(): boolean {
		return this.items.some((item) => item.state === 'uploading');
	}

	get full(): boolean {
		return this.items.length >= ATTACHMENT_MAX;
	}

	/**
	 * Take files from a chooser, a paste or a drop.
	 *
	 * Non-images are dropped silently rather than refused: a paste carries
	 * whatever was on the clipboard, and complaining about the text that came
	 * with the screenshot would be complaining about the normal case.
	 */
	async add(files: Iterable<File>): Promise<void> {
		const images = [...files].filter((file) => file.type.startsWith('image/'));
		if (images.length === 0) return;

		this.error = null;
		for (const file of images) {
			if (this.full) {
				this.error = `That is more than ${ATTACHMENT_MAX} images.`;
				return;
			}
			await this.upload(file);
		}
	}

	/** Take one off again, before it is sent. */
	remove(key: string): void {
		const held = this.items.find((item) => item.key === key);
		if (held?.preview) URL.revokeObjectURL(held.preview);
		this.items = this.items.filter((item) => item.key !== key);
	}

	/** Forget everything, after the message carrying them has posted. */
	clear(): void {
		for (const item of this.items) if (item.preview) URL.revokeObjectURL(item.preview);
		this.items = [];
		this.error = null;
	}

	private async upload(file: File): Promise<void> {
		const key = `u${this.next++}`;
		// A local preview, so the thumbnail is there before the round trip. The
		// URL is revoked on removal and on clear; leaving them is a leak that only
		// shows up after an hour of posting.
		const preview: string | null =
			typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : null;
		const name = file.name || 'image';

		this.items = [...this.items, { state: 'uploading', key, name, preview }];

		try {
			const media: MediaView = await this.actions.uploadMedia(file);
			this.items = this.items.map((item) =>
				item.key === key ? { state: 'done', key, name, preview, media } : item
			);
		} catch (cause) {
			// The failed one goes; the rest stay. Losing three good uploads because
			// the fourth was a 40MB screenshot would be its own bug.
			this.items = this.items.filter((item) => item.key !== key);
			if (preview) URL.revokeObjectURL(preview);
			this.error = actionMessage(cause);
		}
	}
}
