import { render } from 'vitest-browser-svelte';
import { describe, expect, it, vi } from 'vitest';
import TagChips from './TagChips.svelte';
import { aCardTag, aTag } from './testing';

/**
 * The words on a card, and the one click that adds another (migration 039).
 *
 * The owner: "…these can be included on feed posts by agents and users in one
 * click."
 */
const card = { kind: 'update', id: 'u1' };
const bug = aTag({ id: 't1', name: 'Bug', colour: 'rose' });
const feature = aTag({ id: 't2', name: 'Feature' });

function mount(props: Record<string, unknown> = {}) {
	return render(TagChips, {
		card,
		projectId: 'p1',
		tags: [bug, feature],
		worn: [aCardTag({ tagId: 't1', card })],
		...props
	});
}

describe('the words a card is wearing', () => {
	it('shows them', async () => {
		mount();

		expect(document.querySelector('[data-tag="t1"]')?.textContent?.trim()).toBe('Bug');
		expect(document.querySelector('[data-tag="t2"]')).toBeNull();
	});

	it('is read-only without a server behind it, and offers nothing to press', async () => {
		mount({ ontag: undefined, oncreate: undefined });

		expect(document.querySelector('[data-testid="tag-add"]')).toBeNull();
		expect(document.querySelector('[data-tag="t1"]')?.tagName).toBe('SPAN');
	});

	it('renders nothing at all on a bare card with no way to tag it', async () => {
		mount({ worn: [], ontag: undefined });

		expect(document.querySelector('[data-testid="tag-chips"]')).toBeNull();
	});
});

describe('adding one in a click', () => {
	it('offers the project`s words and puts the chosen one on', async () => {
		const ontag = vi.fn();
		const { getByTestId } = mount({ ontag });

		await getByTestId('tag-add').click();
		await getByTestId('tag-picker').element();
		(document.querySelector('[data-pick="t2"]') as HTMLElement).click();

		expect(ontag).toHaveBeenCalledWith('t2', true);
	});

	it('says which ones the card already wears, so the list is a state not a menu', async () => {
		const { getByTestId } = mount({ ontag: vi.fn() });

		await getByTestId('tag-add').click();

		expect(document.querySelector('[data-pick="t1"]')?.getAttribute('aria-pressed')).toBe('true');
		expect(document.querySelector('[data-pick="t2"]')?.getAttribute('aria-pressed')).toBe('false');
	});

	it('takes one off by clicking the chip itself', async () => {
		const ontag = vi.fn();
		mount({ ontag });

		(document.querySelector('[data-tag="t1"]') as HTMLElement).click();

		expect(ontag).toHaveBeenCalledWith('t1', false);
	});

	it('decides a new word when the project has none of the right one', async () => {
		const oncreate = vi.fn();
		const { getByTestId } = mount({ ontag: vi.fn(), oncreate });

		await getByTestId('tag-add').click();
		const box = document.querySelector('[data-testid="tag-new"]') as HTMLInputElement;
		box.value = 'needs design';
		box.dispatchEvent(new Event('input', { bubbles: true }));
		box.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

		// The colour rides with the word, chosen before it exists ("like trello").
		expect(oncreate).toHaveBeenCalledWith('needs design', 'grey');
	});

	it('paints a new word before it exists, the way a Trello label is picked', async () => {
		const oncreate = vi.fn();
		const { getByTestId } = mount({ ontag: vi.fn(), oncreate });

		await getByTestId('tag-add').click();
		(document.querySelector('[data-new-colour="rose"]') as HTMLElement).click();
		const box = document.querySelector('[data-testid="tag-new"]') as HTMLInputElement;
		box.value = 'blocked on design';
		box.dispatchEvent(new Event('input', { bubbles: true }));
		box.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

		expect(oncreate).toHaveBeenCalledWith('blocked on design', 'rose');
	});

	it('repaints a word that already exists, everywhere it is worn', async () => {
		const onrecolour = vi.fn();
		const { getByTestId } = mount({ ontag: vi.fn(), onrecolour });

		await getByTestId('tag-add').click();
		(document.querySelector('[data-paint="t1"]') as HTMLElement).click();
		await vi.waitFor(() => expect(document.querySelector('[data-swatch="amber"]')).not.toBeNull());
		(document.querySelector('[data-swatch="amber"]') as HTMLElement).click();

		expect(onrecolour).toHaveBeenCalledWith('t1', 'amber');
	});

	it('offers no palette without somewhere to send it', async () => {
		const { getByTestId } = mount({ ontag: vi.fn(), onrecolour: undefined });

		await getByTestId('tag-add').click();

		expect(document.querySelector('[data-paint="t1"]')).toBeNull();
	});

	it('says so when a project has decided no words yet', async () => {
		const { getByTestId } = mount({ tags: [], worn: [], ontag: vi.fn() });

		await getByTestId('tag-add').click();

		expect(document.querySelector('[data-testid="tag-picker"]')?.textContent).toContain(
			'no tags yet'
		);
	});
});

/**
 * Getting out of the picker (design §7).
 *
 * The owner: "clicking anywhere should dismiss the tag setting popup."
 */
describe('dismissing the picker', () => {
	it('closes when the reader presses somewhere else', async () => {
		const { getByTestId } = mount({ ontag: vi.fn() });

		await getByTestId('tag-add').click();
		expect(document.querySelector('[data-testid="tag-picker"]')).not.toBeNull();

		document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));

		await vi.waitFor(() => expect(document.querySelector('[data-testid="tag-picker"]')).toBeNull());
	});

	it('stays open for a press inside it', async () => {
		const { getByTestId } = mount({ ontag: vi.fn() });

		await getByTestId('tag-add').click();
		document
			.querySelector('[data-pick="t1"]')!
			.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));

		expect(document.querySelector('[data-testid="tag-picker"]')).not.toBeNull();
	});

	it('closes on Escape', async () => {
		const { getByTestId } = mount({ ontag: vi.fn() });

		await getByTestId('tag-add').click();
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

		await vi.waitFor(() => expect(document.querySelector('[data-testid="tag-picker"]')).toBeNull());
	});

	it('still closes when the button that opened it is pressed again', async () => {
		const { getByTestId } = mount({ ontag: vi.fn() });

		await getByTestId('tag-add').click();
		await getByTestId('tag-add').click();

		expect(document.querySelector('[data-testid="tag-picker"]')).toBeNull();
	});
});
