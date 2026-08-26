import { render } from 'vitest-browser-svelte';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import TimelineView from './Timeline.svelte';
import { Timeline } from './timeline.svelte';
import { FakeStream, anUpdate, fakeActions, fakeApi } from './testing';

/**
 * The live behaviour of the centre column, in a real browser with a real
 * scroll container: new items animate in, and while the reader is scrolled away
 * from the top the viewport must not move under them (design §7).
 */

/**
 * A day's worth of cards, newest first, all on the same local day.
 *
 * The clock is PINNED for this suite rather than read from the run.
 *
 * Deriving the fixture from the real clock looks like the careful choice — a
 * fixed calendar date would rot overnight — but it fails in a worse way: the
 * fixture is computed when this module is imported and the component reads the
 * clock when it renders, so a run that straddles midnight groups the cards
 * against a different "today" than it built them for. CI hit exactly that,
 * expecting ["Today", "Yesterday"] and getting ["Yesterday", "Monday 24 August"].
 *
 * Faking only `Date` keeps timers, rAF and the browser runner untouched, so
 * nothing else in the render path changes behaviour. Midday, midweek, well clear
 * of any DST shift.
 */
const NOW = new Date('2026-03-11T12:00:00');

beforeAll(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(NOW);
});

afterAll(() => {
	vi.useRealTimers();
});

const day = NOW.getTime();
const older = day - 24 * 60 * 60 * 1000;

function updates(count: number) {
	return Array.from({ length: count }, (_, index) =>
		anUpdate({
			id: `u${count - index}`,
			seq: count - index,
			createdAt: day,
			body: `update ${count - index}`
		})
	);
}

let api: ReturnType<typeof fakeApi>;
let stream: FakeStream;

function mount(items = updates(12), props: Record<string, unknown> = {}) {
	api = fakeApi({ seq: items[0]?.seq ?? 0, projects: [], items });
	stream = new FakeStream();
	const feed = new Timeline({
		fetch: api.fetch,
		openStream: () => stream,
		schedule: (run) => api.queue.push(run)
	});
	feed.hydrate(api.snapshot());
	feed.start();
	const screen = render(TimelineView, { feed, ...props });

	// Tailwind's stylesheet is not loaded in a component test, so the two boxes
	// the live behaviour depends on are set here by hand: the scroll container
	// (without which there is nothing to scroll) and the zero-height sticky layer
	// the pill lives in (without which the pill takes real layout space and the
	// browser compensates by moving the scroll position — the very thing the
	// design says must not happen).
	const viewport = document.querySelector('[data-timeline]') as HTMLElement;
	viewport.style.height = '240px';
	viewport.style.overflowY = 'auto';
	const pillLayer = viewport.firstElementChild as HTMLElement;
	pillLayer.style.position = 'sticky';
	pillLayer.style.top = '0';
	pillLayer.style.height = '0';

	return { feed, screen, viewport };
}

/** Scroll and let the browser deliver the event the component listens for. */
async function scrollTo(viewport: HTMLElement, top: number) {
	viewport.scrollTop = top;
	await new Promise((resolve) => setTimeout(resolve, 50));
}

beforeEach(() => {
	document.body.style.margin = '0';
});

describe('rendering the timeline', () => {
	it('groups cards under a heading per day', async () => {
		const items = [
			anUpdate({ id: 'today', seq: 3, createdAt: day }),
			anUpdate({ id: 'yesterday', seq: 2, createdAt: older })
		];
		mount(items);

		const headings = [...document.querySelectorAll('section h2')].map((h) => h.textContent?.trim());
		expect(headings).toEqual(['Today', 'Yesterday']);
	});

	it('says what the dashboard is for when there is nothing in it', async () => {
		const { screen } = mount([]);

		await expect.element(screen.getByText(/Nothing here yet/)).toBeInTheDocument();
	});
});

describe('an update arriving while the reader is at the top', () => {
	it('inserts it and animates it in, without a pill', async () => {
		const { feed } = mount();
		const arrival = anUpdate({ id: 'new', seq: 99, createdAt: day, body: 'just landed' });
		api.publish(arrival);

		stream.emit('update.created', { seq: 99, payload: { updateId: 'new' } });
		await api.settle();

		expect(feed.items[0].id).toBe('new');
		expect(document.querySelector('[data-update-id="new"]')?.className).toContain('update-enter');
		expect(document.querySelector('[data-timeline] button')).toBeNull();
	});
});

describe('an update arriving while the reader is scrolled away', () => {
	it('offers a pill instead of moving the viewport', async () => {
		const { feed, viewport, screen } = mount();
		await scrollTo(viewport, 200);
		expect(feed.pendingCount).toBe(0);
		const before = viewport.scrollTop;

		api.publish(anUpdate({ id: 'new', seq: 99, createdAt: day, body: 'just landed' }));
		stream.emit('update.created', { seq: 99, payload: { updateId: 'new' } });
		await api.settle();

		await expect.element(screen.getByRole('button', { name: '1 new update' })).toBeInTheDocument();
		// The card is not in the document, so nothing above the reader changed.
		expect(document.querySelector('[data-update-id="new"]')).toBeNull();
		expect(viewport.scrollTop).toBe(before);
	});

	it('counts several arrivals in one pill', async () => {
		const { viewport, screen } = mount();
		await scrollTo(viewport, 200);

		api.publish(anUpdate({ id: 'n1', seq: 98, createdAt: day }));
		stream.emit('update.created', { seq: 98, payload: { updateId: 'n1' } });
		await api.settle();
		api.publish(anUpdate({ id: 'n2', seq: 99, createdAt: day }));
		stream.emit('update.created', { seq: 99, payload: { updateId: 'n2' } });
		await api.settle();

		await expect.element(screen.getByRole('button', { name: '2 new updates' })).toBeInTheDocument();
	});

	it('shows them when the pill is clicked', async () => {
		const { viewport, screen } = mount();
		await scrollTo(viewport, 200);
		api.publish(anUpdate({ id: 'new', seq: 99, createdAt: day, body: 'just landed' }));
		stream.emit('update.created', { seq: 99, payload: { updateId: 'new' } });
		await api.settle();

		await screen.getByRole('button', { name: '1 new update' }).click();

		await expect.element(screen.getByText('just landed')).toBeInTheDocument();
		expect(document.querySelector('[data-update-id="new"]')?.className).toContain('update-enter');
	});

	it('shows them by itself once the reader scrolls back to the top', async () => {
		const { viewport, screen } = mount();
		await scrollTo(viewport, 200);
		api.publish(anUpdate({ id: 'new', seq: 99, createdAt: day, body: 'just landed' }));
		stream.emit('update.created', { seq: 99, payload: { updateId: 'new' } });
		await api.settle();

		await scrollTo(viewport, 0);

		await expect.element(screen.getByText('just landed')).toBeInTheDocument();
	});
});

describe('a deleted update', () => {
	it('disappears from the timeline', async () => {
		const { screen } = mount();
		await expect.element(screen.getByText('update 12')).toBeInTheDocument();

		stream.emit('update.deleted', { seq: 99, payload: { updateId: 'u12' } });
		await api.settle();

		expect(document.querySelector('[data-update-id="u12"]')).toBeNull();
	});
});

describe('paging into the past', () => {
	it('offers older updates only when there are some', async () => {
		const { screen } = mount();

		expect(screen.getByRole('button', { name: /Load older/ }).elements()).toHaveLength(0);
	});
});

/**
 * Pinned updates sort first (issue #16). They are lifted out of the day groups
 * rather than reordered inside them: an update pinned three weeks ago belongs at
 * the top of the feed, and leaving it under "3 August" while claiming it is
 * first would be a lie the reader has to scroll to discover.
 */
describe('pinned updates', () => {
	it('renders them above every day group, under their own heading', async () => {
		mount([
			anUpdate({ id: 'plain', seq: 3, createdAt: day, body: 'plain one' }),
			anUpdate({ id: 'pinned', seq: 1, createdAt: older, pinned: true, body: 'the pinned one' })
		]);

		const headings = [...document.querySelectorAll('section h2')].map((h) => h.textContent?.trim());
		expect(headings).toEqual(['Pinned', 'Today']);

		const rendered = [...document.querySelectorAll('[data-update-id]')].map((card) =>
			card.getAttribute('data-update-id')
		);
		expect(rendered).toEqual(['pinned', 'plain']);
	});

	it('offers no pinned section when nothing is pinned', async () => {
		mount([anUpdate({ id: 'plain', seq: 3, createdAt: day })]);

		const headings = [...document.querySelectorAll('section h2')].map((h) => h.textContent?.trim());
		expect(headings).toEqual(['Today']);
	});

	it('hands every card the owner controls it was given', async () => {
		const api = fakeActions();
		mount([anUpdate({ id: 'u1', seq: 1, createdAt: day })], { actions: api.actions });

		const cards = document.querySelectorAll('[data-update-id]');
		expect(document.querySelectorAll('[data-update-actions]')).toHaveLength(cards.length);
	});
});
