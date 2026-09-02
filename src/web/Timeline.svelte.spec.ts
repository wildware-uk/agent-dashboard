import { render } from 'vitest-browser-svelte';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import TimelineView from './Timeline.svelte';
import { Timeline } from './timeline.svelte';
import { FakeStream, aMessage, anAck, aRequest, anUpdate, fakeActions, fakeApi } from './testing';

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

/**
 * Requests at the top of the feed (design §7).
 *
 * They are handed in already scoped — the shell decides which of the owner's
 * requests belong on this feed — so what these specs pin down is placement and
 * nothing else: above the pinned section, above the day groups, and never
 * rendered without an action client to answer them with.
 */
describe('requests waiting on the owner', () => {
	const acts = () => fakeActions().actions;

	it('puts them above the pinned section and the day groups', async () => {
		mount(
			[
				anUpdate({ id: 'pinned', seq: 4, createdAt: day, pinned: true }),
				anUpdate({ id: 'plain', seq: 3, createdAt: day })
			],
			{ requests: [aRequest({ id: 'r1', question: 'Push to main?' })], actions: acts() }
		);

		const headings = [...document.querySelectorAll('section h2')].map((h) => h.textContent?.trim());
		expect(headings).toEqual(['Waiting on you', 'Pinned', 'Today']);
	});

	it('renders one card per request, in the order it was given them', async () => {
		mount(updates(1), {
			requests: [
				aRequest({ id: 'r1', seq: 1, question: 'Push to main?' }),
				aRequest({ id: 'r2', seq: 2, question: 'Which branch?' })
			],
			actions: acts()
		});

		const rendered = [...document.querySelectorAll('[data-request-id]')].map((card) =>
			card.getAttribute('data-request-id')
		);
		expect(rendered).toEqual(['r1', 'r2']);
	});

	it('counts them once there is more than one, so none is missed', async () => {
		const { screen } = mount(updates(1), {
			requests: [aRequest({ id: 'r1', seq: 1 }), aRequest({ id: 'r2', seq: 2 })],
			actions: acts()
		});

		await expect.element(screen.getByTestId('request-count')).toHaveTextContent('(2)');
	});

	it('leaves the count off when only one agent is blocked', async () => {
		const { screen } = mount(updates(1), { requests: [aRequest()], actions: acts() });

		await expect.element(screen.getByTestId('request-count')).not.toBeInTheDocument();
	});

	it('names the project on the card when the shell supplies one', async () => {
		const { screen } = mount(updates(1), {
			requests: [aRequest({ projectId: 'p2' })],
			projectNames: { p2: 'Mega Merge' },
			actions: acts()
		});

		await expect.element(screen.getByTestId('request-project')).toHaveTextContent('Mega Merge');
	});

	it('renders none of them without an action client to answer with', async () => {
		const { screen } = mount(updates(1), { requests: [aRequest()] });

		await expect.element(screen.getByTestId('request-section')).not.toBeInTheDocument();
	});

	it('is not an empty feed just because there are no updates yet', async () => {
		const { screen } = mount([], { requests: [aRequest()], actions: acts() });

		await expect.element(screen.getByTestId('request-card')).toBeInTheDocument();
		await expect.element(screen.getByText(/Nothing here yet/)).not.toBeInTheDocument();
	});
});

/**
 * Cards with a conversation on them, lifted to the top (design §7).
 *
 * The same shape as pinning, and for the same reason: reordering a card inside
 * its own day group would put it at the top of Tuesday and nowhere near the top
 * of the feed.
 */
describe('recent replies', () => {
	const threadsFor = (byUpdate: Record<string, ReturnType<typeof aMessage>[]>) => ({
		// The section only lifts conversations the owner is part of, so a fixture
		// thread is "they said something, an agent answered" — the newest message
		// is what the section sorts on, and it has to be the agent's.
		for: (updateId: string) =>
			(byUpdate[updateId] ?? []).flatMap((message, index) => [
				aMessage({ id: `${message.id}-asked`, updateId, author: 'human', createdAt: index }),
				{ ...message, author: 'agent:a1' }
			]),
		forTask: () => []
	});

	it('lifts a replied-to card above the day groups', async () => {
		mount(
			[
				anUpdate({ id: 'chatty', seq: 2, createdAt: older, body: 'an older card' }),
				anUpdate({ id: 'fresh', seq: 3, createdAt: day, body: 'a newer card' })
			],
			{
				threads: threadsFor({ chatty: [aMessage({ updateId: 'chatty', createdAt: day })] })
			}
		);

		const headings = [...document.querySelectorAll('section h2')].map((h) => h.textContent?.trim());
		expect(headings).toEqual(['Recent replies', 'Today']);

		const rendered = [...document.querySelectorAll('[data-update-id]')].map((card) =>
			card.getAttribute('data-update-id')
		);
		// Lifted once, and gone from the day group it would otherwise sit in.
		expect(rendered).toEqual(['chatty', 'fresh']);
	});

	it('orders by the newest reply, not by the card', async () => {
		mount(
			[
				anUpdate({ id: 'first', seq: 3, createdAt: day }),
				anUpdate({ id: 'second', seq: 2, createdAt: day })
			],
			{
				threads: threadsFor({
					first: [aMessage({ updateId: 'first', createdAt: day })],
					second: [aMessage({ updateId: 'second', createdAt: day + 1_000 })]
				})
			}
		);

		const lifted = [
			...document.querySelectorAll('[data-testid="replied-section"] [data-update-id]')
		];
		expect(lifted.map((card) => card.getAttribute('data-update-id'))).toEqual(['second', 'first']);
	});

	it('leaves a pinned card where pinning already put it', async () => {
		mount([anUpdate({ id: 'pinned', seq: 3, createdAt: day, pinned: true })], {
			threads: threadsFor({ pinned: [aMessage({ updateId: 'pinned', createdAt: day })] })
		});

		const headings = [...document.querySelectorAll('section h2')].map((h) => h.textContent?.trim());
		expect(headings).toEqual(['Pinned']);
		expect(document.querySelectorAll('[data-update-id="pinned"]')).toHaveLength(1);
	});

	it('caps the section rather than becoming most of the feed', async () => {
		const items = Array.from({ length: 8 }, (_, index) =>
			anUpdate({ id: `u${index}`, seq: 8 - index, createdAt: day })
		);
		const byUpdate = Object.fromEntries(
			items.map((item, index) => [
				item.id,
				[aMessage({ updateId: item.id, createdAt: day + index })]
			])
		);

		mount(items, { threads: threadsFor(byUpdate) });

		expect(
			document.querySelectorAll('[data-testid="replied-section"] [data-update-id]')
		).toHaveLength(5);
	});

	it('offers no section when nothing has been replied to', async () => {
		mount(updates(2), { threads: threadsFor({}) });

		expect(document.querySelector('[data-testid="replied-section"]')).toBeNull();
	});

	it('offers no section at all without a thread store', async () => {
		mount(updates(2));

		expect(document.querySelector('[data-testid="replied-section"]')).toBeNull();
	});
});

/**
 * The owner's own posts, as cards in the feed (migration 014).
 *
 * They interleave with the agents' updates by time rather than sitting in a
 * section of their own: "have a look at this" and the update that answers it
 * belong next to each other, and a second timeline above the first is a second
 * thing to read.
 */
describe('what the owner posted', () => {
	const source = (
		posts: ReturnType<typeof aMessage>[],
		replies: ReturnType<typeof aMessage>[] = []
	) => ({
		for: () => [],
		forTask: () => [],
		posts: () => posts,
		repliesTo: (id: string) => replies.filter((reply) => reply.replyTo === id)
	});

	const post = (over: Record<string, unknown> = {}) =>
		aMessage({
			id: 'post1',
			updateId: null,
			taskId: null,
			replyTo: null,
			author: 'human',
			body: 'have a look at the migration',
			createdAt: day,
			...over
		});

	it('renders a post as a card, attributed to the owner', async () => {
		const { screen } = mount([anUpdate({ id: 'u1', seq: 2, createdAt: day })], {
			threads: source([post()])
		});

		await expect.element(screen.getByText('have a look at the migration')).toBeInTheDocument();
		expect(document.querySelector('[data-post="post1"]')).not.toBeNull();
		await expect.element(screen.getByText('You')).toBeInTheDocument();
	});

	it('interleaves it with the updates by time, newest first', async () => {
		mount(
			[
				anUpdate({ id: 'older', seq: 1, createdAt: day - 2_000, body: 'an older card' }),
				anUpdate({ id: 'newer', seq: 2, createdAt: day, body: 'a newer card' })
			],
			{ threads: source([post({ createdAt: day - 1_000 })]) }
		);

		const order = [...document.querySelectorAll('[data-update-id], [data-post]')].map(
			(card) => card.getAttribute('data-update-id') ?? card.getAttribute('data-post')
		);
		expect(order).toEqual(['newer', 'post1', 'older']);
	});

	it('shows the replies under it', async () => {
		const { screen } = mount([], {
			threads: source(
				[post()],
				[aMessage({ id: 'r1', replyTo: 'post1', author: 'agent:a1', body: 'on it' })]
			),
			agentNames: { a1: 'scout' }
		});

		await expect.element(screen.getByText('on it')).toBeInTheDocument();
	});

	it('renders nothing extra when the owner has posted nothing', async () => {
		mount([anUpdate({ id: 'u1', seq: 2, createdAt: day })], { threads: source([]) });

		expect(document.querySelector('[data-post]')).toBeNull();
	});
});

/**
 * Marking a conversation read (migration 015).
 *
 * Without it "Recent replies" only ever grew, and the cards riding above the
 * timeline became the ones that had been ignored the longest.
 */
describe('finishing with a conversation', () => {
	const chatty = () => anUpdate({ id: 'chatty', seq: 2, createdAt: day, body: 'a card' });
	/** The owner asked, an agent answered: what the section lifts. */
	const threadsFor = (byUpdate: Record<string, ReturnType<typeof aMessage>[]>) => ({
		for: (updateId: string) =>
			(byUpdate[updateId] ?? []).flatMap((message, index) => [
				aMessage({ id: `${message.id}-asked`, updateId, author: 'human', createdAt: index }),
				{ ...message, author: 'agent:a1' }
			]),
		forTask: () => []
	});

	it('offers a way to be done with one, and calls it with that card', async () => {
		const acts = fakeActions();
		const { screen } = mount([chatty()], {
			threads: threadsFor({ chatty: [aMessage({ updateId: 'chatty', createdAt: day })] }),
			actions: acts.actions
		});

		await screen.getByTestId('mark-replies-read').click();

		expect(acts.calls).toEqual([{ name: 'markRepliesSeen', args: ['chatty'] }]);
	});

	it('marks the whole section read in one click', async () => {
		const acts = fakeActions();
		const items = [
			anUpdate({ id: 'a', seq: 3, createdAt: day }),
			anUpdate({ id: 'b', seq: 2, createdAt: day })
		];
		const { screen } = mount(items, {
			threads: threadsFor({
				a: [aMessage({ updateId: 'a', createdAt: day })],
				b: [aMessage({ updateId: 'b', createdAt: day + 1 })]
			}),
			actions: acts.actions
		});

		await screen.getByTestId('mark-all-replies-read').click();

		expect(acts.calls.map((call) => call.args[0]).sort()).toEqual(['a', 'b']);
	});

	it('drops a card back into its day once the owner has read it', async () => {
		const read = anUpdate({ id: 'chatty', seq: 2, createdAt: day, repliesSeenAt: day + 5_000 });

		mount([read], {
			threads: threadsFor({ chatty: [aMessage({ updateId: 'chatty', createdAt: day + 1_000 })] })
		});

		expect(document.querySelector('[data-testid="replied-section"]')).toBeNull();
		const headings = [...document.querySelectorAll('section h2')].map((h) => h.textContent?.trim());
		expect(headings).toEqual(['Today']);
	});

	it('lifts it again when a newer reply lands', async () => {
		const read = anUpdate({ id: 'chatty', seq: 2, createdAt: day, repliesSeenAt: day });

		mount([read], {
			threads: threadsFor({ chatty: [aMessage({ updateId: 'chatty', createdAt: day + 9_000 })] })
		});

		expect(document.querySelector('[data-testid="replied-section"]')).not.toBeNull();
	});

	it('offers no dismissal at all without a server behind it', async () => {
		mount([chatty()], {
			threads: threadsFor({ chatty: [aMessage({ updateId: 'chatty', createdAt: day })] })
		});

		expect(document.querySelector('[data-testid="mark-replies-read"]')).toBeNull();
		expect(document.querySelector('[data-testid="mark-all-replies-read"]')).toBeNull();
	});
});

/**
 * Acknowledging what the owner posted (#feedback: "allow agents to acknowledge
 * user posted messages, just like they can comments").
 *
 * The tool already accepted a post's id — an owner post *is* a message — but
 * the card never rendered the answer, so an agent could say "on it" into a void.
 */
describe('an agent acknowledging a post', () => {
	const post = () =>
		aMessage({
			id: 'post1',
			updateId: null,
			taskId: null,
			replyTo: null,
			author: 'human',
			body: 'have a look at the migration',
			createdAt: day
		});

	it('shows the tick on the post itself, under what the owner said', async () => {
		const { screen } = mount([], {
			threads: {
				for: () => [],
				forTask: () => [],
				posts: () => [post()],
				repliesTo: () => [],
				acksFor: (id: string) =>
					id === 'post1' ? [anAck({ messageId: 'post1', state: 'done', agentId: 'a1' })] : []
			},
			agentNames: { a1: 'scout' }
		});

		await expect.element(screen.getByText('scout marked this done')).toBeInTheDocument();
		expect(document.querySelector('[data-post="post1"] [data-ack]')).not.toBeNull();
	});

	it('animates a live "thinking" while that agent is online', async () => {
		const { screen } = mount([], {
			threads: {
				for: () => [],
				forTask: () => [],
				posts: () => [post()],
				repliesTo: () => [],
				acksFor: () => [anAck({ messageId: 'post1', state: 'thinking', agentId: 'a1' })]
			},
			agentNames: { a1: 'scout' },
			onlineIds: ['a1']
		});

		await expect.element(screen.getByText(/scout is thinking/)).toBeInTheDocument();
	});

	it('leaves the post plain when nobody has acknowledged it', async () => {
		mount([], {
			threads: { for: () => [], forTask: () => [], posts: () => [post()], repliesTo: () => [] }
		});

		expect(document.querySelector('[data-post="post1"] [data-ack]')).toBeNull();
	});
});

/**
 * Whose conversations ride the top (#feedback: "Recent replies should only show
 * replies to me, not to other agents").
 *
 * The section exists so an answer to the owner is not buried in a day group.
 * One agent leaving a note on another's card is not that, and a section holding
 * both is one the owner has to filter by eye.
 */
describe('recent replies, scoped to the owner', () => {
	const threadsFor = (byUpdate: Record<string, ReturnType<typeof aMessage>[]>) => ({
		for: (updateId: string) => byUpdate[updateId] ?? [],
		forTask: () => []
	});

	it('lifts a card where an agent answered the owner', async () => {
		mount([anUpdate({ id: 'mine', seq: 2, createdAt: day })], {
			threads: threadsFor({
				mine: [
					aMessage({ id: 'm1', updateId: 'mine', author: 'human', createdAt: day }),
					aMessage({ id: 'm2', updateId: 'mine', author: 'agent:a1', createdAt: day + 1_000 })
				]
			})
		});

		expect(document.querySelector('[data-testid="replied-section"]')).not.toBeNull();
	});

	it('leaves a thread the owner never spoke in where it is', async () => {
		mount([anUpdate({ id: 'theirs', seq: 2, createdAt: day })], {
			threads: threadsFor({
				theirs: [
					aMessage({ id: 'm1', updateId: 'theirs', author: 'agent:a1', createdAt: day }),
					aMessage({ id: 'm2', updateId: 'theirs', author: 'agent:a2', createdAt: day + 1_000 })
				]
			})
		});

		expect(document.querySelector('[data-testid="replied-section"]')).toBeNull();
	});

	it('does not lift a card whose newest message is the owner’s own', async () => {
		// Nobody has answered yet. Parking your own words at the top of your own
		// feed is not news.
		mount([anUpdate({ id: 'mine', seq: 2, createdAt: day })], {
			threads: threadsFor({
				mine: [
					aMessage({ id: 'm1', updateId: 'mine', author: 'agent:a1', createdAt: day }),
					aMessage({ id: 'm2', updateId: 'mine', author: 'human', createdAt: day + 1_000 })
				]
			})
		});

		expect(document.querySelector('[data-testid="replied-section"]')).toBeNull();
	});
});
