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

/**
 * Sharing (design §7, §8): the one control here that makes something readable
 * without a session, so what is asserted is that the URL is shown, that the card
 * says it is public, and that the owner can take it back.
 */
describe('sharing a card', () => {
	it('mints a link and shows it in full, because it is shown exactly once', async () => {
		const api = fakeActions();
		const screen = render(UpdateActions, { update: anUpdate({ id: 'u7' }), actions: api.actions });

		await screen.getByTestId('share-update').click();

		expect(api.calls).toEqual([{ name: 'shareUpdate', args: ['u7'] }]);
		await expect
			.element(screen.getByRole('textbox', { name: 'Public link to this update' }))
			.toHaveValue('https://dash.test/s/token-for-u7');
	});

	it('warns that anyone with the link can read the card', async () => {
		const api = fakeActions();
		const screen = render(UpdateActions, { update: anUpdate(), actions: api.actions });

		await screen.getByTestId('share-update').click();

		await expect.element(screen.getByText(/Anyone with this link/)).toBeInTheDocument();
	});

	it('says a card is public before anything is clicked, with the view count', async () => {
		const api = fakeActions();
		const screen = render(UpdateActions, {
			update: anUpdate({ share: { views: 3, sharedAt: 1 } }),
			actions: api.actions
		});

		await expect.element(screen.getByTestId('share-state')).toHaveTextContent('Public · 3 views');
	});

	it('counts one view in the singular, because "1 views" reads as a bug', async () => {
		const api = fakeActions();
		const screen = render(UpdateActions, {
			update: anUpdate({ share: { views: 1, sharedAt: 1 } }),
			actions: api.actions
		});

		await expect.element(screen.getByTestId('share-state')).toHaveTextContent('Public · 1 view');
	});

	it('offers no share state at all on a card that is not shared', async () => {
		const api = fakeActions();
		const screen = render(UpdateActions, { update: anUpdate(), actions: api.actions });

		await expect.element(screen.getByTestId('share-state')).not.toBeInTheDocument();
		await expect.element(screen.getByTestId('share-link')).not.toBeInTheDocument();
	});

	it('stops sharing, and takes the link off screen with it', async () => {
		const api = fakeActions();
		const screen = render(UpdateActions, {
			update: anUpdate({ id: 'u7', share: { views: 0, sharedAt: 1 } }),
			actions: api.actions
		});

		await screen.getByTestId('share-update').click();
		await screen.getByRole('button', { name: 'Stop sharing' }).click();

		expect(api.calls).toEqual([
			{ name: 'shareUpdate', args: ['u7'] },
			{ name: 'revokeShare', args: ['u7'] }
		]);
		await expect.element(screen.getByTestId('share-link')).not.toBeInTheDocument();
	});

	it('keeps the card exactly as it was when the server refuses', async () => {
		const api = fakeActions();
		const screen = render(UpdateActions, { update: anUpdate(), actions: api.actions });
		api.fail(new Error('the server said no'));

		await screen.getByTestId('share-update').click();

		await expect.element(screen.getByRole('alert')).toBeInTheDocument();
		await expect.element(screen.getByTestId('share-link')).not.toBeInTheDocument();
	});
});
