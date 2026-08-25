import { render } from 'vitest-browser-svelte';
import { describe, expect, it } from 'vitest';
import UpdateActions from './UpdateActions.svelte';
import { anUpdate, fakeActions } from './testing';

/**
 * The owner's controls on one card (design §7): pin, and delete behind a
 * confirmation. The confirmation is the point of most of these — a delete that
 * one stray click can perform is a delete that will happen by accident.
 */
describe('pinning an update', () => {
	it('asks the server to pin it', async () => {
		const api = fakeActions();
		const screen = render(UpdateActions, { update: anUpdate({ id: 'u7' }), actions: api.actions });

		await screen.getByRole('button', { name: 'Pin update' }).click();

		expect(api.calls).toEqual([{ name: 'setUpdatePinned', args: ['u7', true] }]);
	});

	it('offers to unpin one that is already pinned', async () => {
		const api = fakeActions();
		const screen = render(UpdateActions, {
			update: anUpdate({ id: 'u7', pinned: true }),
			actions: api.actions
		});

		await screen.getByRole('button', { name: 'Unpin update' }).click();

		expect(api.calls).toEqual([{ name: 'setUpdatePinned', args: ['u7', false] }]);
	});
});

describe('deleting an update', () => {
	it('asks first, and deletes nothing until the owner says yes twice', async () => {
		const api = fakeActions();
		const screen = render(UpdateActions, { update: anUpdate({ id: 'u7' }), actions: api.actions });

		await screen.getByRole('button', { name: 'Delete update' }).click();

		expect(api.calls).toEqual([]);
		await expect.element(screen.getByText(/Delete this update/)).toBeInTheDocument();

		await screen.getByRole('button', { name: 'Confirm delete' }).click();

		expect(api.calls).toEqual([{ name: 'deleteUpdate', args: ['u7'] }]);
	});

	it('forgets the whole thing when the owner backs out', async () => {
		const api = fakeActions();
		const screen = render(UpdateActions, { update: anUpdate({ id: 'u7' }), actions: api.actions });

		await screen.getByRole('button', { name: 'Delete update' }).click();
		await screen.getByRole('button', { name: 'Cancel' }).click();

		expect(api.calls).toEqual([]);
		expect(screen.getByRole('button', { name: 'Confirm delete' }).elements()).toHaveLength(0);
	});

	it('says so when the server refuses, and leaves the card alone', async () => {
		const api = fakeActions();
		api.fail(new Error('no such update: u7'));
		const screen = render(UpdateActions, { update: anUpdate({ id: 'u7' }), actions: api.actions });

		await screen.getByRole('button', { name: 'Delete update' }).click();
		await screen.getByRole('button', { name: 'Confirm delete' }).click();

		await expect.element(screen.getByText(/no such update/)).toBeInTheDocument();
	});
});
