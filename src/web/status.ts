/**
 * What a card's work state looks like (migration 035).
 *
 * The owner: "agents can mark a card in the feed as a task, and update the
 * status of the card, in progress, done, blocked etc." So the board's columns
 * became a chip on the card, and this is the one place that decides what each
 * state is called and what colour it carries.
 *
 * The colours are the ones the rest of the dashboard already uses for the same
 * meanings — amber for waiting on somebody, rose for stopped, emerald for
 * finished — so a reader who has learnt the feed does not have to learn a
 * second vocabulary for work.
 */

/** The five states, in the order work moves through them. */
export const STATUSES = ['todo', 'in_progress', 'blocked', 'done', 'cancelled'] as const;

export type CardStatus = (typeof STATUSES)[number];

export type StatusLook = { label: string; chip: string };

const LOOKS: Record<CardStatus, StatusLook> = {
	todo: {
		label: 'To do',
		chip: 'bg-surface text-content-muted border border-border-subtle'
	},
	in_progress: {
		// "In progress" rather than "claimed": the board's word described who had
		// it, and what a reader wants to know is whether it is moving.
		label: 'In progress',
		chip: 'bg-amber-500 text-black'
	},
	blocked: { label: 'Blocked', chip: 'bg-rose-600 text-white' },
	done: { label: 'Done', chip: 'bg-emerald-700 text-white' },
	cancelled: {
		label: 'Cancelled',
		chip: 'bg-surface text-content-muted border border-border-subtle line-through'
	}
};

/** How to draw one state, or `null` for a card nobody has marked as work. */
export function statusLook(status: string | null | undefined): StatusLook | null {
	if (!status) return null;
	return LOOKS[status as CardStatus] ?? null;
}

/** Whether the work is still going, which is what the feed sorts and counts on. */
export function isOpen(status: string | null | undefined): boolean {
	return status === 'todo' || status === 'in_progress' || status === 'blocked';
}
