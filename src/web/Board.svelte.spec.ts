import { render } from 'vitest-browser-svelte';
import { describe, expect, it, vi } from 'vitest';
import Board from './Board.svelte';
import { aTask } from './testing';

/**
 * The board, as its own tab beside the feed (design §7).
 *
 * Columns are a view over task states rather than a second vocabulary: a state
 * is what an agent wrote, and a column is how the owner wants to look at them.
 */

const titles = () =>
	[...document.querySelectorAll('[data-testid="board-column-title"]')].map((node) =>
		node.textContent?.trim()
	);

describe('the default board', () => {
	it('lays tasks out as waiting, in progress and done', async () => {
		render(Board, {
			tasks: [
				aTask({ id: 't1', state: 'todo', title: 'Queued' }),
				aTask({ id: 't2', state: 'claimed', title: 'Doing' }),
				aTask({ id: 't3', state: 'done', title: 'Finished' })
			]
		});

		expect(titles()).toEqual(['To do', 'In progress', 'Done']);
		expect(document.querySelectorAll('[data-testid="board-task"]')).toHaveLength(3);
	});

	it('has no column for cancelled work, which is not a lane anybody works', async () => {
		render(Board, { tasks: [aTask({ state: 'cancelled' })] });

		expect(titles()).toEqual(['To do', 'In progress', 'Done']);
		expect(document.querySelectorAll('[data-testid="board-task"]')).toHaveLength(0);
	});

	it('says the board is empty rather than rendering a blank tab', async () => {
		render(Board, { tasks: [] });

		// A tab the owner clicked into and found blank reads as broken; the lanes
		// stay on screen so it reads as "no tasks yet".
		expect(document.querySelector('[data-testid="board-empty"]')).not.toBeNull();
		expect(document.querySelector('[data-testid="board-columns"]')).not.toBeNull();
	});

	it('filters the feed rather than navigating away', async () => {
		const onselect = vi.fn();
		const screen = render(Board, { tasks: [aTask({ id: 't7', state: 'todo' })], onselect });

		await screen.getByTestId('board-task').click();

		expect(onselect).toHaveBeenCalledWith('t7');
		// Not a link: the board and the feed are two views of the same work, and
		// leaving the page would take the board away to show what is under it.
		expect(document.querySelector('[data-testid="board-task"]')?.tagName).toBe('BUTTON');
	});

	it('clears the filter when the selected task is clicked again', async () => {
		const onselect = vi.fn();
		const screen = render(Board, {
			tasks: [aTask({ id: 't7', state: 'todo' })],
			selected: 't7',
			onselect
		});

		await screen.getByTestId('board-task').click();

		expect(onselect).toHaveBeenCalledWith(null);
	});

	it('says which task is selected, to a screen reader as well', async () => {
		const screen = render(Board, { tasks: [aTask({ id: 't7', state: 'todo' })], selected: 't7' });

		await expect.element(screen.getByTestId('board-task')).toHaveAttribute('aria-pressed', 'true');
	});
});

describe('columns the owner configured', () => {
	it('uses them instead of the default', async () => {
		render(Board, {
			tasks: [aTask({ state: 'todo' }), aTask({ id: 't2', state: 'done' })],
			board: {
				columns: [
					{ title: 'Queue', states: ['todo'] },
					{ title: 'Over', states: ['done', 'cancelled'] }
				]
			}
		});

		expect(titles()).toEqual(['Queue', 'Over']);
	});

	it('gathers several states into one column', async () => {
		render(Board, {
			tasks: [aTask({ id: 't1', state: 'done' }), aTask({ id: 't2', state: 'cancelled' })],
			board: { columns: [{ title: 'Over', states: ['done', 'cancelled'] }] }
		});

		expect(document.querySelectorAll('[data-testid="board-task"]')).toHaveLength(2);
	});

	it('says a lane is empty rather than leaving a gap', async () => {
		render(Board, {
			tasks: [aTask({ state: 'todo' })],
			board: {
				columns: [
					{ title: 'Queue', states: ['todo'] },
					{ title: 'Doing', states: ['claimed'] }
				]
			}
		});

		expect(document.body.textContent).toContain('Nothing here.');
	});
});
