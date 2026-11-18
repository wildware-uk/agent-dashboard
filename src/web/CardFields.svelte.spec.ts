import { render } from 'vitest-browser-svelte';
import { describe, expect, it, vi } from 'vitest';
import CardFields from './CardFields.svelte';
import { aCardField } from './testing';

/**
 * What is known about a card, out of the way until it is wanted
 * (migration 040).
 *
 * The owner: "they are hidden by default, but can be viewed on the dashboard,
 * and updated by the user and agent alike."
 */
const card = { kind: 'update', id: 'u1' };
const branch = aCardField({ id: 'f1', name: 'branch', slug: 'branch', value: 'fix/fees' });
const link = aCardField({
	id: 'f2',
	name: 'PR link',
	slug: 'pr-link',
	value: 'https://example.test/pr/1'
});

function mount(props: Record<string, unknown> = {}) {
	return render(CardFields, { card, fields: [branch, link], ...props });
}

describe('hidden until asked for', () => {
	it('shows one line with the count, and nothing else', async () => {
		mount();

		expect(document.querySelector('[data-testid="fields-toggle"]')?.textContent).toContain(
			'Details (2)'
		);
		expect(document.querySelector('[data-testid="fields-list"]')).toBeNull();
	});

	it('opens on a press', async () => {
		const { getByTestId } = mount();

		await getByTestId('fields-toggle').click();

		expect(document.querySelector('[data-field="branch"]')?.textContent).toContain('fix/fees');
	});

	it('renders nothing at all on a bare card nobody can write to', async () => {
		mount({ fields: [], onset: undefined });

		expect(document.querySelector('[data-testid="card-fields"]')).toBeNull();
	});

	it('still offers the panel on an empty card the owner can write to', async () => {
		const { getByTestId } = mount({ fields: [], onset: vi.fn() });

		await getByTestId('fields-toggle').click();

		expect(document.querySelector('[data-testid="fields-list"]')?.textContent).toContain(
			'Nothing noted'
		);
	});
});

describe('a value that is a link', () => {
	it('is a link, opened away from this page', async () => {
		const { getByTestId } = mount();

		await getByTestId('fields-toggle').click();

		const anchor = document.querySelector('[data-field="pr-link"] a') as HTMLAnchorElement;
		expect(anchor.href).toBe('https://example.test/pr/1');
		expect(anchor.rel).toContain('noopener');
	});

	it('is plain text when it is not one', async () => {
		const { getByTestId } = mount({
			fields: [aCardField({ slug: 'branch', value: 'javascript:alert(1)' })]
		});

		await getByTestId('fields-toggle').click();

		expect(document.querySelector('[data-field="branch"] a')).toBeNull();
	});
});

describe('the owner correcting what an agent wrote', () => {
	it('adds one', async () => {
		const onset = vi.fn();
		const { getByTestId } = mount({ onset });

		await getByTestId('fields-toggle').click();
		const name = document.querySelector('[data-testid="field-name"]') as HTMLInputElement;
		const value = document.querySelector('[data-testid="field-value"]') as HTMLInputElement;
		name.value = 'environment';
		name.dispatchEvent(new Event('input', { bubbles: true }));
		value.value = 'staging';
		value.dispatchEvent(new Event('input', { bubbles: true }));
		name.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

		expect(onset).toHaveBeenCalledWith('environment', 'staging');
	});

	it('corrects one in place', async () => {
		const onset = vi.fn();
		const { getByTestId } = mount({ onset });

		await getByTestId('fields-toggle').click();
		(document.querySelector('[data-edit="branch"]') as HTMLElement).click();
		await vi.waitFor(() =>
			expect(document.querySelector('[data-testid="field-edit"]')).not.toBeNull()
		);
		const box = document.querySelector('[data-testid="field-edit"]') as HTMLInputElement;
		box.value = 'fix/fees-2';
		box.dispatchEvent(new Event('input', { bubbles: true }));
		box.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

		expect(onset).toHaveBeenCalledWith('branch', 'fix/fees-2');
	});

	it('takes one off', async () => {
		const onset = vi.fn();
		const { getByTestId } = mount({ onset });

		await getByTestId('fields-toggle').click();
		(document.querySelector('[data-remove="branch"]') as HTMLElement).click();

		expect(onset).toHaveBeenCalledWith('branch', null);
	});

	it('offers no controls without a server behind it', async () => {
		const { getByTestId } = mount({ onset: undefined });

		await getByTestId('fields-toggle').click();

		expect(document.querySelector('[data-edit="branch"]')).toBeNull();
		expect(document.querySelector('[data-testid="field-name"]')).toBeNull();
	});
});
