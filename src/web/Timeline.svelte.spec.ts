import { render } from 'vitest-browser-svelte';
import { beforeEach, describe, expect, it } from 'vitest';
import TimelineView from './Timeline.svelte';
import { Timeline } from './timeline.svelte';
import { FakeStream, anUpdate, fakeApi } from './testing';

/**
 * The live behaviour of the centre column, in a real browser with a real
 * scroll container: new items animate in, and while the reader is scrolled away
 * from the top the viewport must not move under them (design §7).
 */

/** A day's worth of cards, newest first, all on the same local day. */
const day = new Date(2026, 7, 25, 12).getTime();
const older = new Date(2026, 7, 24, 12).getTime();

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

function mount(items = updates(12)) {
	api = fakeApi({ seq: items[0]?.seq ?? 0, projects: [], items });
	stream = new FakeStream();
	const feed = new Timeline({
		fetch: api.fetch,
		openStream: () => stream,
		schedule: (run) => api.queue.push(run)
	});
	feed.hydrate(api.snapshot());
	feed.start();
	const screen = render(TimelineView, { feed });

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
