// The real stylesheet, so a chip's colour is the one a browser would paint.
import '../http/routes/app.css';
import { render } from 'vitest-browser-svelte';
import { describe, expect, it, vi } from 'vitest';
import StatusChip from './StatusChip.svelte';

/**
 * A card's work state, and the way to change it (migration 035).
 *
 * The owner: "remove tasks and the board, instead agents can mark a card in the
 * feed as a task, and update the status of the card, in progress, done, blocked
 * etc." The board's columns are this chip.
 */
describe('the state on a card', () => {
	it('says where the work has got to', async () => {
		const screen = render(StatusChip, { status: 'in_progress' });

		await expect.element(screen.getByTestId('status-chip')).toHaveTextContent('In progress');
	});

	it('shows nothing on an ordinary card, which is most of them', async () => {
		const screen = render(StatusChip, { status: null });

		expect(screen.container.querySelector('[data-testid="status-chip"]')).toBeNull();
		expect(screen.container.querySelector('[data-testid="mark-work"]')).toBeNull();
	});

	it('offers to mark one when the owner can write', async () => {
		const screen = render(StatusChip, { status: null, onstatus: async () => {} });

		await expect.element(screen.getByTestId('mark-work')).toBeInTheDocument();
	});

	it('sets the state the owner picked', async () => {
		const onstatus = vi.fn().mockResolvedValue(undefined);
		const screen = render(StatusChip, { status: null, onstatus });

		await screen.getByTestId('mark-work').click();
		await screen.getByRole('button', { name: 'Blocked' }).click();

		expect(onstatus).toHaveBeenCalledWith('blocked');
	});

	it('takes the mark off again, which is how a mistake is undone', async () => {
		const onstatus = vi.fn().mockResolvedValue(undefined);
		const screen = render(StatusChip, { status: 'todo', onstatus });

		await screen.getByTestId('status-chip').click();
		await screen.getByTestId('unmark-work').click();

		expect(onstatus).toHaveBeenCalledWith(null);
	});

	it('is read-only without a writer, so a shared card cannot be moved', async () => {
		const screen = render(StatusChip, { status: 'done' });

		// The chip still says what the state is; it simply does not open.
		await expect.element(screen.getByTestId('status-chip')).toBeDisabled();
		expect(screen.container.querySelector('[data-testid="status-menu"]')).toBeNull();
	});
});
