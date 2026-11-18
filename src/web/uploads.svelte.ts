/**
 * Files waiting to go out with a message (migration 016, migration 026).
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
 *
 * **Anything may be sent**, not only pictures (migration 026): the owner asked to
 * be able to hand an agent a PDF, a log or a zip. The server decides what it will
 * take; this box's job is to say what happened. A picture still gets a local
 * thumbnail, and everything else gets its name — which is all a `.tar.gz` has to
 * show anyway.
 */
import type { MediaView } from './types';
import type { OwnerActions } from './actions';
import { actionMessage } from './actions';

/** One attachment, from chosen to uploaded. */
export type Attachment =
	| {
			state: 'uploading';
			key: string;
			name: string;
			preview: string | null;
			/**
			 * How far along, 0-100, or `null` when nothing can say.
			 *
			 * A browser that cannot report progress, or a file with no length, leaves
			 * this `null`, and the box shows a busy state with no number rather than a
			 * bar stuck at zero — a bar that never moves is worse than no bar.
			 */
			percent: number | null;
	  }
	| { state: 'done'; key: string; name: string; preview: string | null; media: MediaView };

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
	 * Everything offered is sent, whatever it is (migration 026). Nothing is
	 * filtered out here on type any more: a paste that carried only text carries
	 * no *files* at all, so the case this used to guard against never reaches
	 * this method, and filtering on `image/` is what stopped a log file being
	 * droppable.
	 */
	async add(files: Iterable<File>): Promise<void> {
		const chosen = [...files];
		if (chosen.length === 0) return;

		this.error = null;
		for (const file of chosen) {
			if (this.full) {
				this.error = `That is more than ${ATTACHMENT_MAX} attachments.`;
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

	/**
	 * Move one bar, and only if it actually moved.
	 *
	 * Progress fires tens of times a second. Rebuilding the list for a percentage
	 * that has not changed is a re-render per event for nothing, and this box is
	 * on the screen the owner is typing into.
	 */
	private advance(key: string, percent: number): void {
		const held = this.items.find((item) => item.key === key);
		if (!held || held.state !== 'uploading' || held.percent === percent) return;
		this.items = this.items.map((item) =>
			item.key === key && item.state === 'uploading' ? { ...item, percent } : item
		);
	}

	private async upload(file: File): Promise<void> {
		const key = `u${this.next++}`;
		// A local preview, so the thumbnail is there before the round trip — for a
		// picture. A PDF has nothing to show, and an object URL for one would be a
		// broken `<img>`, so only images get one. The URL is revoked on removal and
		// on clear; leaving them is a leak that only shows up after an hour of
		// posting.
		const preview: string | null =
			file.type.startsWith('image/') && typeof URL.createObjectURL === 'function'
				? URL.createObjectURL(file)
				: null;
		const name = file.name || 'attachment';

		// `file.size` is the fallback denominator: the progress event carries its
		// own total, but only once the first one arrives, and the bar should be at
		// zero rather than absent before then.
		const size = file.size > 0 ? file.size : null;

		this.items = [
			...this.items,
			{ state: 'uploading', key, name, preview, percent: size === null ? null : 0 }
		];

		try {
			const media: MediaView = await this.actions.uploadMedia(file, (sent, total) => {
				const whole = total ?? size;
				if (!whole) return;
				this.advance(key, Math.max(0, Math.min(100, Math.round((sent / whole) * 100))));
			});
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
