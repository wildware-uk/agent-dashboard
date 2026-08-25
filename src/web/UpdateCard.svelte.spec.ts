import { render } from 'vitest-browser-svelte';
import { describe, expect, it } from 'vitest';
import UpdateCard from './UpdateCard.svelte';
import { aMedia, anUpdate, fakeActions } from './testing';

/**
 * The card in a real browser. The markdown case here is the one that matters:
 * `markdown.test.ts` proves the *string* is escaped, and this proves the DOM
 * agrees — no element is created, and the owner sees the tag as text.
 */
describe('untrusted markdown in a rendered card', () => {
	it('renders a script tag as text and creates no element', async () => {
		const screen = render(UpdateCard, {
			update: anUpdate({ body: 'before <script>window.__pwned = true</script> after' })
		});

		await expect.element(screen.getByText(/<script>/)).toBeInTheDocument();
		expect(document.querySelector('article script')).toBeNull();
		expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
	});

	it('renders an img tag as text, so no onerror handler ever runs', async () => {
		const screen = render(UpdateCard, {
			update: anUpdate({ body: '<img src=x onerror="window.__pwned = true">' })
		});

		await expect.element(screen.getByText(/<img src=x/)).toBeInTheDocument();
		expect(document.querySelector('article img')).toBeNull();
	});

	it('still renders real markdown as markup', async () => {
		const screen = render(UpdateCard, { update: anUpdate({ body: '**shipped**' }) });

		await expect.element(screen.getByText('shipped')).toBeInTheDocument();
		expect(document.querySelector('article strong')?.textContent).toBe('shipped');
	});
});

describe('the card', () => {
	it('carries its level as colour and as words', async () => {
		const screen = render(UpdateCard, { update: anUpdate({ level: 'error' }) });

		await expect.element(screen.getByText('Error')).toBeInTheDocument();
		expect(document.querySelector('article')?.dataset.level).toBe('error');
		// The level colour is a class on the left edge, not a style on the card.
		expect(document.querySelector('article span[aria-hidden="true"]')?.className).toContain(
			'bg-rose-500'
		);
	});

	it('shows a name-hashed avatar for the poster', async () => {
		render(UpdateCard, { update: anUpdate({ agentId: 'a1' }), agentName: 'release bot' });

		const avatar = document.querySelector('[data-hue]');
		expect(avatar?.textContent).toContain('RB');
		expect(Number(avatar?.getAttribute('data-hue'))).toBeGreaterThanOrEqual(0);
	});

	it('falls back to the agent id when no name is known yet', async () => {
		const screen = render(UpdateCard, { update: anUpdate({ agentId: 'agent-7' }) });

		await expect.element(screen.getByText('agent-7')).toBeInTheDocument();
	});

	it('attributes the update to the agent, not to its id', async () => {
		const agentId = '01M0X5XHT67FCP294SSA3B2XHV';
		const screen = render(UpdateCard, {
			update: anUpdate({ agentId }),
			agentName: 'build-bot'
		});

		await expect.element(screen.getByText('build-bot')).toBeInTheDocument();
		expect(document.querySelector('article')?.textContent).not.toContain(agentId);
		expect(document.querySelector('article')?.getAttribute('aria-label')).toBe(
			'Info update from build-bot'
		);
		expect(document.querySelector('[data-hue]')?.textContent?.trim()).toBe('BB');
	});

	it('badges two differently-named agents differently', async () => {
		// The bug (#20): both of these used to read "01", because every ULID begins
		// `01` until 2039, so the hue was the only thing telling them apart.
		render(UpdateCard, {
			update: anUpdate({ id: 'u1', agentId: '01M0X5XHT67FCP294SSA3B2XHV' }),
			agentName: 'docs-writer'
		});
		render(UpdateCard, {
			update: anUpdate({ id: 'u2', agentId: '01M0X5XHT67FCP294SSAKQ9WFP' }),
			agentName: 'build-bot'
		});

		const badges = [...document.querySelectorAll('[data-hue]')].map((badge) =>
			badge.textContent?.trim()
		);
		expect(badges).toEqual(['DW', 'BB']);
	});

	it('shortens an id nobody has a name for instead of printing all 26 characters', async () => {
		const agentId = '01M0X5XHT67FCP294SSA3B2XHV';
		const screen = render(UpdateCard, { update: anUpdate({ agentId }) });

		await expect.element(screen.getByText('agent-3b2xhv')).toBeInTheDocument();
		expect(document.querySelector('article')?.textContent).not.toContain(agentId);
	});

	it('renders a title when there is one', async () => {
		const screen = render(UpdateCard, { update: anUpdate({ title: 'Build green' }) });

		await expect.element(screen.getByRole('heading', { name: 'Build green' })).toBeInTheDocument();
	});

	it('keeps a media region, empty when the update carries nothing', async () => {
		render(UpdateCard, { update: anUpdate() });

		expect(document.querySelector('[data-media-region]')).not.toBeNull();
		expect(document.querySelector('[data-media-grid]')).toBeNull();
	});

	it('renders the media on the row, without being handed anything else', async () => {
		// The card renders from the row: no store, no fetch, no snippet. That is
		// what makes it the same card whether it came from the server render or
		// from the store replacing it after `media.ready`.
		render(UpdateCard, { update: anUpdate({ media: [aMedia({ id: 'm1' })] }) });

		expect(document.querySelector('[data-media-grid]')).not.toBeNull();
		expect(document.querySelector('img')?.getAttribute('src')).toBe('/media/m1/thumb-640');
	});

	it('animates in only when it arrived live', async () => {
		render(UpdateCard, { update: anUpdate({ id: 'u9' }), isNew: true });

		expect(document.querySelector('article')?.className).toContain('update-enter');
	});

	it('does not animate a card that came from the server render', async () => {
		render(UpdateCard, { update: anUpdate({ id: 'u8' }) });

		expect(document.querySelector('article')?.className).not.toContain('update-enter');
	});
});

describe('the owner controls on a card', () => {
	it('are absent until the card is handed an action client', async () => {
		const screen = render(UpdateCard, { update: anUpdate() });

		expect(screen.getByRole('button', { name: /update/ }).elements()).toHaveLength(0);
	});

	it('pin and delete the card they are on', async () => {
		const api = fakeActions();
		const screen = render(UpdateCard, { update: anUpdate({ id: 'u9' }), actions: api.actions });

		await screen.getByRole('button', { name: 'Pin update' }).click();

		expect(api.calls).toEqual([{ name: 'setUpdatePinned', args: ['u9', true] }]);
		await expect.element(screen.getByRole('button', { name: 'Delete update' })).toBeInTheDocument();
	});

	it('says a pinned card is pinned, without the owner opening anything', async () => {
		render(UpdateCard, { update: anUpdate({ id: 'u9', pinned: true }) });

		expect(document.querySelector('article')?.textContent).toContain('Pinned');
	});
});
