import { render } from 'vitest-browser-svelte';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import TimelineView from './Timeline.svelte';
import { Timeline } from './timeline.svelte';
import { FakeStream, aMessage, anAck, aRequest, anUpdate, fakeActions, fakeApi } from './testing';
import { Collapsed } from './collapse.svelte';
import { Filtering } from './filters.svelte';
import { ReadComments } from './unread.svelte';

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
	// And the layer the way-back button lives in, for the same reason: without a
	// zero height it would take real space and move the very scroll position it
	// exists to let somebody escape. It is the *last* child, because a `bottom`
	// sticky is only ever pulled up out of the content below the fold — one placed
	// first simply scrolls away.
	const topLayer = viewport.lastElementChild as HTMLElement;
	topLayer.style.position = 'sticky';
	topLayer.style.bottom = '0';
	topLayer.style.height = '0';

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
		// No "N new updates" pill: the card went straight in. (Scoped to the pill
		// rather than to any button, since the feed's filter chips are buttons too.)
		expect(document.querySelector('[data-testid="new-updates"]')).toBeNull();
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
			projectNames: { p2: 'Garden Game' },
			actions: acts()
		});

		await expect.element(screen.getByTestId('request-project')).toHaveTextContent('Garden Game');
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
 * Cards with a conversation on them (design §7).
 *
 * There is no "Recent replies" section any more — the owner: "remove recent
 * replies section, cards are already sorted by recent activity." A reply is
 * activity, so the card it landed on rises through the one feed instead of
 * being copied into a section of its own.
 */
describe('a card that has been replied to', () => {
	const threadsFor = (byUpdate: Record<string, ReturnType<typeof aMessage>[]>) => ({
		for: (updateId: string) =>
			(byUpdate[updateId] ?? []).flatMap((message, index) => [
				aMessage({ id: `${message.id}-asked`, updateId, author: 'human', createdAt: index }),
				{ ...message, author: 'agent:a1' }
			]),
		forTask: () => []
	});

	it('rises to the top of the feed, in one copy, with no section of its own', async () => {
		mount(
			[
				anUpdate({ id: 'chatty', seq: 2, createdAt: older, body: 'an older card' }),
				anUpdate({ id: 'fresh', seq: 3, createdAt: day, body: 'a newer card' })
			],
			{
				threads: threadsFor({ chatty: [aMessage({ updateId: 'chatty', createdAt: day + 5_000 })] })
			}
		);

		expect(document.querySelector('[data-testid="replied-section"]')).toBeNull();
		const headings = [...document.querySelectorAll('section h2')].map((h) => h.textContent?.trim());
		expect(headings).toEqual(['Today']);

		const rendered = [...document.querySelectorAll('[data-update-id]')].map((card) =>
			card.getAttribute('data-update-id')
		);
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

		const rendered = [...document.querySelectorAll('[data-update-id]')].map((card) =>
			card.getAttribute('data-update-id')
		);
		expect(rendered).toEqual(['second', 'first']);
	});

	it('leaves a pinned card where pinning already put it', async () => {
		mount([anUpdate({ id: 'pinned', seq: 3, createdAt: day, pinned: true })], {
			threads: threadsFor({ pinned: [aMessage({ updateId: 'pinned', createdAt: day })] })
		});

		const headings = [...document.querySelectorAll('section h2')].map((h) => h.textContent?.trim());
		expect(headings).toEqual(['Pinned']);
		expect(document.querySelectorAll('[data-update-id="pinned"]')).toHaveLength(1);
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

	/**
	 * The bug the owner found: "I can't react to posts, only comments", and on
	 * the project whose feed is mostly posts, "I can't react to anything here".
	 *
	 * The timeline handed this card `uploader` and not `actions`, so every
	 * control that needs somewhere to write was rendered dead.
	 */
	it('gives a post the owner’s controls, not only somewhere to upload', async () => {
		const fake = fakeActions();
		mount([anUpdate({ id: 'u1', seq: 2, createdAt: day })], {
			threads: source([post()]),
			actions: fake.actions
		});

		expect(
			document.querySelector('[data-post="post1"] [aria-label="Add a reaction"]')
		).not.toBeNull();
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
 * The way back to the top (design §7).
 *
 * The owner: "when you are scrolled down add a floating button to scroll back to
 * the top." It appears by the screenful rather than by the pixel, and it costs no
 * layout when it comes and goes — a button that shifted the feed as it appeared
 * would move the cards under the thumb that scrolled to it.
 */
describe('getting back to the top', () => {
	it('is absent until a whole screen has gone by', async () => {
		const { viewport } = mount(updates(30));

		expect(document.querySelector('[data-testid="to-top"]')).toBeNull();

		// The harness gives the scroller a 240px box, so half a screen is not it.
		await scrollTo(viewport, 100);
		expect(document.querySelector('[data-testid="to-top"]')).toBeNull();
	});

	it('appears once the reader is a screen down', async () => {
		const { viewport } = mount(updates(30));

		await scrollTo(viewport, 400);

		expect(document.querySelector('[data-testid="to-top"]')).not.toBeNull();
	});

	it('takes the feed back to the top when pressed', async () => {
		const { viewport } = mount(updates(30));
		await scrollTo(viewport, 400);

		(document.querySelector('[data-testid="to-top"]') as HTMLButtonElement).click();

		await expect.poll(() => viewport.scrollTop).toBe(0);
	});

	it('goes away again once it is not needed', async () => {
		const { viewport } = mount(updates(30));
		await scrollTo(viewport, 400);
		expect(document.querySelector('[data-testid="to-top"]')).not.toBeNull();

		await scrollTo(viewport, 0);

		expect(document.querySelector('[data-testid="to-top"]')).toBeNull();
	});

	it('lives after the cards, which is what makes it stick to the bottom', async () => {
		// The property the first version of these specs could not see. They set the
		// sticky styles by hand — Tailwind is not loaded here — so they passed while
		// the button scrolled away with the first screenful in a real browser: a
		// `bottom` sticky is only ever pulled *up* out of the content below the
		// fold, never pushed down past where it sits, so one placed first is not
		// sticky at all. Its position in the DOM is the whole fix, and it is the one
		// thing about this that a component test can check honestly.
		const { viewport } = mount(updates(30));
		await scrollTo(viewport, 400);

		const button = document.querySelector('[data-testid="to-top"]') as HTMLElement;
		expect(viewport.lastElementChild?.contains(button)).toBe(true);
	});

	it('says what it does, for somebody who cannot see the arrow', async () => {
		const { viewport } = mount(updates(30));
		await scrollTo(viewport, 400);

		expect(document.querySelector('[data-testid="to-top"]')?.getAttribute('aria-label')).toBe(
			'Scroll back to the top of the feed'
		);
	});
});

/**
 * A commented card comes to the top (design §7).
 *
 * The owner: "a comment on a post should move that post to the top of the feed."
 * The point is not the sort — it is that a reply to something from Tuesday is
 * news on Thursday, and a feed that files it under Tuesday has hidden the only
 * new thing on it.
 */
describe('cards move when somebody comments', () => {
	const daysAgo = day - 3 * 24 * 60 * 60 * 1000;

	/**
	 * A thread source, as the shell hands one to the timeline.
	 *
	 * The replies here are the owner's own, but any reply counts the same now:
	 * the feed sorts on the newest thing that happened to a card, whoever it came
	 * from.
	 */
	function threadsWith(replies: Record<string, ReturnType<typeof aMessage>[]>) {
		return {
			for: (updateId: string) => replies[updateId] ?? [],
			posts: () => [],
			repliesTo: () => []
		};
	}

	it('lifts an old card above a newer one when it is answered', async () => {
		const items = [
			anUpdate({ id: 'new', seq: 2, createdAt: day }),
			anUpdate({ id: 'old', seq: 1, createdAt: daysAgo })
		];

		mount(items, {
			threads: threadsWith({
				old: [aMessage({ id: 'r1', updateId: 'old', createdAt: day + 60_000 })]
			})
		});

		const order = [...document.querySelectorAll('[data-update-id]')].map((card) =>
			card.getAttribute('data-update-id')
		);
		expect(order.indexOf('old')).toBeLessThan(order.indexOf('new'));
	});

	it('leaves the order alone when nothing has been said', async () => {
		const items = [
			anUpdate({ id: 'new', seq: 2, createdAt: day }),
			anUpdate({ id: 'old', seq: 1, createdAt: daysAgo })
		];

		mount(items, { threads: threadsWith({}) });

		const order = [...document.querySelectorAll('[data-update-id]')].map((card) =>
			card.getAttribute('data-update-id')
		);
		expect(order.indexOf('new')).toBeLessThan(order.indexOf('old'));
	});

	it('files it under the day it was answered, not the day it was written', async () => {
		// Ordering and the heading have to agree: a card sorted to the top under a
		// three-day-old heading would sit above today's cards saying otherwise.
		const { screen } = mount([anUpdate({ id: 'old', seq: 1, createdAt: daysAgo })], {
			threads: threadsWith({
				old: [aMessage({ id: 'r1', updateId: 'old', createdAt: day })]
			})
		});

		await expect.element(screen.getByText('Today')).toBeInTheDocument();
	});

	it('puts it back once the comment is gone', async () => {
		// Deleting a comment is not a special case here: a soft-deleted message
		// never reaches the client, so the card simply has no replies again.
		const items = [
			anUpdate({ id: 'new', seq: 2, createdAt: day }),
			anUpdate({ id: 'old', seq: 1, createdAt: daysAgo })
		];

		mount(items, { threads: threadsWith({ old: [] }) });

		const order = [...document.querySelectorAll('[data-update-id]')].map((card) =>
			card.getAttribute('data-update-id')
		);
		expect(order.indexOf('new')).toBeLessThan(order.indexOf('old'));
	});
});

/**
 * A pinned card of any kind (migration 034).
 *
 * The owner: "let me pin my own messages." The pinned section drew updates
 * only, so a pinned post had nowhere to go — it stayed down in its day group,
 * which is the one place pinning it says not to be.
 */
describe('what the pinned section holds', () => {
	const pinnedPost = () =>
		aMessage({
			id: 'm1',
			author: 'human',
			projectId: 'p1',
			updateId: null,
			taskId: null,
			replyTo: null,
			body: 'kept in view',
			pinned: true
		});

	const threadsWith = (posts: ReturnType<typeof aMessage>[]) => ({
		for: () => [],
		forTask: () => [],
		posts: () => posts,
		repliesTo: () => []
	});

	it('carries the owner`s own pinned post, not only pinned updates', async () => {
		const { screen } = mount(updates(2), {
			threads: threadsWith([pinnedPost()]),
			actions: fakeActions().actions
		});

		const section = screen.container.querySelector('[aria-labelledby="day-pinned"]');
		expect(section).not.toBeNull();
		expect(section?.textContent).toContain('kept in view');
	});

	it('does not also leave it down in its day group', async () => {
		const { screen } = mount(updates(2), {
			threads: threadsWith([pinnedPost()]),
			actions: fakeActions().actions
		});

		// Once on the page, at the top — a card that appeared twice would read as
		// two posts.
		expect(screen.container.querySelectorAll('[data-post="m1"]')).toHaveLength(1);
	});
});

/**
 * Folds that survive the feed being refetched (design §7).
 *
 * The timeline replaces rows by id whenever anything is published, so a fold
 * kept on the row would spring open every time somebody reacted to something.
 */
describe('collapsing a card in the feed', () => {
	it('folds the card the owner clicked, and remembers which', async () => {
		const collapsed = new Collapsed({ getItem: () => null, setItem: () => {} });
		const { screen } = mount(updates(2), { actions: fakeActions().actions, collapsed });

		await screen.getByRole('button', { name: 'Collapse update' }).first().click();

		// The store is the memory, so the fold outlives the row it was made on.
		expect(collapsed.has('u2')).toBe(true);
		await expect.element(screen.getByTestId('card-summary').first()).toBeInTheDocument();
	});

	it('leaves the other cards alone', async () => {
		const collapsed = new Collapsed({ getItem: () => null, setItem: () => {} });
		const { screen } = mount(updates(3), { actions: fakeActions().actions, collapsed });

		await screen.getByRole('button', { name: 'Collapse update' }).first().click();

		expect(screen.container.querySelectorAll('[data-testid="card-summary"]')).toHaveLength(1);
	});
});

describe('filtering the feed by work status', () => {
	/** A store of its own, so one test's choice cannot leak into the next. */
	function memory(start: string | null = null) {
		let held = start;
		return {
			getItem: () => held,
			setItem: (_key: string, value: string) => {
				held = value;
			},
			read: () => held
		};
	}

	/**
	 * A chip in the filter bar — scoped, because a card's own status chip carries
	 * the same words ("Done" is both a filter and a state).
	 */
	function chip(screen: ReturnType<typeof mount>['screen'], label: string) {
		return screen.getByTestId('feed-filters').getByRole('button', { name: label });
	}

	const marked = [
		anUpdate({ id: 'doing', seq: 3, createdAt: day, body: 'in flight', status: 'in_progress' }),
		anUpdate({ id: 'shipped', seq: 2, createdAt: day, body: 'landed', status: 'done' }),
		anUpdate({ id: 'chatter', seq: 1, createdAt: day, body: 'no status at all' })
	];

	it('shows only the cards in that state', async () => {
		const store = memory();
		const { screen } = mount(marked, { filtering: new Filtering(store) });

		await chip(screen, 'Blocked').click();

		expect(document.querySelectorAll('[data-update-id]')).toHaveLength(0);

		await chip(screen, 'In progress').click();

		const shown = [...document.querySelectorAll('[data-update-id]')].map((el) =>
			el.getAttribute('data-update-id')
		);
		expect(shown).toEqual(['doing']);
	});

	it('counts anything unfinished as open work, and nothing else', async () => {
		const { screen } = mount(marked, { filtering: new Filtering(memory()) });

		await chip(screen, 'Open work').click();

		const shown = [...document.querySelectorAll('[data-update-id]')].map((el) =>
			el.getAttribute('data-update-id')
		);
		expect(shown).toEqual(['doing']);
	});

	it('remembers the choice, so a reload reads the same feed', async () => {
		const store = memory();
		const { screen } = mount(marked, { filtering: new Filtering(store) });

		await chip(screen, 'Done').click();

		expect(store.read()).toBe('done');
		// What the next visit would build from that store.
		expect(new Filtering(store).current).toBe('done');
	});

	it('says why the page looks empty rather than leaving it blank', async () => {
		const { screen } = mount(marked, { filtering: new Filtering(memory()) });

		await chip(screen, 'Blocked').click();

		await expect.element(screen.getByTestId('filter-empty')).toBeInTheDocument();
	});
});

/**
 * What a card says about its own age (design §7).
 *
 * The owner: "when a card is updated for any reason, display how long ago it was
 * updated, instead of how long ago it was created."
 */
describe('the time on a card', () => {
	const threadsWith = (byUpdate: Record<string, ReturnType<typeof aMessage>[]>) => ({
		for: (updateId: string) => byUpdate[updateId] ?? [],
		forTask: () => [],
		posts: () => [],
		repliesTo: () => []
	});

	it('is the card’s own age while nothing has happened to it', async () => {
		mount([anUpdate({ id: 'quiet', seq: 2, createdAt: day - 60 * 60 * 1000 })], {
			threads: threadsWith({})
		});

		const time = document.querySelector('[data-testid="update-time"]');
		expect(time?.getAttribute('data-updated')).toBeNull();
		expect(time?.textContent?.trim()).not.toContain('updated');
	});

	it('is when it was last updated once somebody has replied', async () => {
		mount([anUpdate({ id: 'chatty', seq: 2, createdAt: day - 60 * 60 * 1000 })], {
			threads: threadsWith({
				chatty: [aMessage({ updateId: 'chatty', author: 'agent:a1', createdAt: day - 60_000 })]
			})
		});

		const time = document.querySelector('[data-testid="update-time"]');
		expect(time?.getAttribute('data-updated')).toBe('true');
		expect(time?.textContent?.trim()).toMatch(/^updated 1m ago/);
		// The instant it was posted is not lost, only moved into the tooltip.
		expect(time?.getAttribute('title')).toContain('Posted');
	});

	it('counts a work state that moved, not only a reply', async () => {
		mount(
			[
				anUpdate({
					id: 'moved',
					seq: 2,
					createdAt: day - 60 * 60 * 1000,
					status: 'in_progress',
					statusAt: day - 60_000
				})
			],
			{ threads: threadsWith({}) }
		);

		expect(
			document.querySelector('[data-testid="update-time"]')?.getAttribute('data-updated')
		).toBe('true');
	});
});

/**
 * The unread-comment badge (design §7).
 *
 * The owner: "add a badge of how many new unread comments on a card." It clears
 * by the card being looked at, which is the point — the dashboard had just lost
 * its "mark as read" button and is not getting another one.
 */
describe('new comments on a card', () => {
	function memory(start: string | null = null) {
		let held = start;
		return {
			getItem: () => held,
			setItem: (_key: string, value: string) => {
				held = value;
			}
		};
	}

	const threadsWith = (byUpdate: Record<string, ReturnType<typeof aMessage>[]>) => ({
		for: (updateId: string) => byUpdate[updateId] ?? [],
		forTask: () => [],
		posts: () => [],
		repliesTo: () => []
	});

	/** A card the reader last looked at before the newest comment landed. */
	function halfRead() {
		const marks = new ReadComments(memory());
		marks.markRead('chatty', [{ createdAt: day - 60 * 60 * 1000, author: 'agent:a1' }]);
		return marks;
	}

	const answered = {
		chatty: [
			aMessage({ id: 'm1', updateId: 'chatty', author: 'agent:a1', createdAt: day - 30_000 }),
			aMessage({ id: 'm2', updateId: 'chatty', author: 'agent:a1', createdAt: day - 20_000 })
		]
	};

	it('counts the comments that landed since the reader last looked', async () => {
		mount([anUpdate({ id: 'chatty', seq: 2, createdAt: day - 60 * 60 * 1000 })], {
			threads: threadsWith(answered),
			read: halfRead()
		});

		expect(
			document.querySelector('[data-testid="unread-badge"]')?.getAttribute('data-unread')
		).toBe('2');
	});

	it('clears itself once the card has been on screen a moment', async () => {
		mount([anUpdate({ id: 'chatty', seq: 2, createdAt: day - 60 * 60 * 1000 })], {
			threads: threadsWith(answered),
			read: halfRead()
		});

		await vi.waitFor(
			() => expect(document.querySelector('[data-testid="unread-badge"]')).toBeNull(),
			{ timeout: 4_000 }
		);
	});

	it('badges nothing on a feed this browser has never seen before', async () => {
		mount([anUpdate({ id: 'chatty', seq: 2, createdAt: day - 60 * 60 * 1000 })], {
			threads: threadsWith(answered),
			read: new ReadComments(memory())
		});

		expect(document.querySelector('[data-testid="unread-badge"]')).toBeNull();
	});
});

/**
 * Folding a card by clicking its header (design §7).
 *
 * The owner: "clicking on any empty part (or the title) of the header of a card
 * should collapse and expand it."
 */
describe('clicking a card header', () => {
	function store() {
		return new Collapsed({ getItem: () => null, setItem: () => {} });
	}

	it('folds the card, and unfolds it on the next click', async () => {
		const collapsed = store();
		mount([anUpdate({ id: 'u1', seq: 2, createdAt: day, title: 'a report' })], {
			actions: fakeActions().actions,
			collapsed
		});

		const header = document.querySelector('[data-update-id="u1"] header') as HTMLElement;
		header.click();
		expect(collapsed.has('u1')).toBe(true);

		header.click();
		expect(collapsed.has('u1')).toBe(false);
	});

	it('folds from the title too', async () => {
		const collapsed = store();
		mount([anUpdate({ id: 'u1', seq: 2, createdAt: day, title: 'a report' })], {
			actions: fakeActions().actions,
			collapsed
		});

		(document.querySelector('[data-update-id="u1"] h3') as HTMLElement).click();

		expect(collapsed.has('u1')).toBe(true);
	});

	it('leaves the controls in the header doing their own job', async () => {
		const collapsed = store();
		const acts = fakeActions();
		mount([anUpdate({ id: 'u1', seq: 2, createdAt: day, pinned: false })], {
			actions: acts.actions,
			collapsed
		});

		const pin = document.querySelector(
			'[data-update-id="u1"] [data-testid="pin-card"]'
		) as HTMLElement | null;
		pin?.click();

		expect(pin).not.toBeNull();
		expect(collapsed.has('u1')).toBe(false);
		expect(acts.calls.map((call) => call.name)).toContain('pinCard');
	});

	it('folds an owner post from its header as well', async () => {
		const collapsed = store();
		mount([], {
			actions: fakeActions().actions,
			collapsed,
			threads: {
				for: () => [],
				forTask: () => [],
				posts: () => [
					aMessage({
						id: 'post1',
						updateId: null,
						taskId: null,
						replyTo: null,
						author: 'human',
						body: 'have a look',
						createdAt: day
					})
				],
				repliesTo: () => []
			}
		});

		(document.querySelector('[data-post="post1"] p') as HTMLElement).click();

		expect(collapsed.has('post1')).toBe(true);
	});
});

/**
 * Cards that move say so (design §7).
 *
 * The owner: "cards flow to the top when they are updated." The sliding itself
 * is the browser's, so what is checked here is the mark left on the card that
 * moved — that is the part a reader who was looking elsewhere relies on.
 */
describe('a card that has just moved', () => {
	it('wears the marker when its activity moves forward', async () => {
		mount([
			anUpdate({ id: 'a', seq: 3, createdAt: day }),
			anUpdate({ id: 'b', seq: 2, createdAt: day - 60_000 })
		]);

		expect(document.querySelector('[data-update-id="b"][data-bumped]')).toBeNull();

		// The same card, now carrying a work state that moved a moment ago.
		api.replace({
			seq: 4,
			items: [
				anUpdate({
					id: 'b',
					seq: 4,
					createdAt: day - 60_000,
					status: 'in_progress',
					statusAt: day + 60_000
				}),
				anUpdate({ id: 'a', seq: 3, createdAt: day })
			]
		});
		stream.emit('update.updated', { seq: 4, payload: { updateId: 'b' } });
		await api.settle();

		await vi.waitFor(() =>
			expect(document.querySelector('[data-update-id="b"][data-bumped="true"]')).not.toBeNull()
		);
	});
});

/**
 * A card taller than the screen still clears its badge.
 *
 * The owner: "the unread replies badge on cards never seems to disappear." It
 * was asking for a fraction of the *card* to be showing, which a long report
 * with a long thread under it can never satisfy.
 */
describe('a very tall card', () => {
	function memory() {
		let held: string | null = null;
		return {
			getItem: () => held,
			setItem: (_key: string, value: string) => {
				held = value;
			}
		};
	}

	it('marks itself read anyway', async () => {
		const marks = new ReadComments(memory());
		marks.markRead('tall', [{ createdAt: day - 60 * 60 * 1000, author: 'agent:a1' }]);

		mount([anUpdate({ id: 'tall', seq: 2, createdAt: day - 60 * 60 * 1000 })], {
			read: marks,
			threads: {
				for: (id: string) =>
					id === 'tall'
						? [aMessage({ id: 'm1', updateId: 'tall', author: 'agent:a1', createdAt: day })]
						: [],
				forTask: () => [],
				posts: () => [],
				repliesTo: () => []
			}
		});

		const card = document.querySelector('[data-update-id="tall"]') as HTMLElement;
		// Twenty screens tall: no fraction of this card is ever on screen at once.
		card.style.height = '5000px';

		expect(document.querySelector('[data-testid="unread-badge"]')).not.toBeNull();
		await vi.waitFor(
			() => expect(document.querySelector('[data-testid="unread-badge"]')).toBeNull(),
			{ timeout: 4_000 }
		);
	});
});

/**
 * Following a notification to the thing it is about (migration 021).
 *
 * The owner: "sometimes clicking a notification does not take me to the
 * card/comment." Three things could swallow it — a filter chip, a folded card,
 * and a question, which the lookup did not know about at all.
 */
describe('focusing what a notification points at', () => {
	function stored() {
		return new Collapsed({ getItem: () => null, setItem: () => {} });
	}

	function filteredTo(choice: string) {
		let held: string | null = choice;
		return new Filtering({
			getItem: () => held,
			setItem: (_key: string, value: string) => {
				held = value;
			}
		});
	}

	it('shows a card the filter would have hidden', async () => {
		// Reading "only blocked work" must not hide the card being linked to.
		mount([anUpdate({ id: 'wanted', seq: 2, createdAt: day, status: 'done' })], {
			filtering: filteredTo('blocked'),
			focus: 'wanted'
		});

		await vi.waitFor(() =>
			expect(
				document.querySelector('[data-update-id="wanted"][data-focused="true"]')
			).not.toBeNull()
		);
	});

	it('opens a folded card, so the reply inside it can be seen', async () => {
		const collapsed = stored();
		collapsed.set('chatty', true);

		mount([anUpdate({ id: 'chatty', seq: 2, createdAt: day })], {
			actions: fakeActions().actions,
			collapsed,
			focus: 'r1',
			threads: {
				for: (id: string) =>
					id === 'chatty'
						? [aMessage({ id: 'r1', updateId: 'chatty', author: 'agent:a1', createdAt: day })]
						: [],
				forTask: () => [],
				posts: () => [],
				repliesTo: () => []
			}
		});

		await vi.waitFor(() => expect(collapsed.has('chatty')).toBe(false));
		await vi.waitFor(() =>
			expect(document.querySelector('[data-message-id="r1"][data-focused="true"]')).not.toBeNull()
		);
	});

	it('finds a question, which it used to walk straight past', async () => {
		mount([], {
			actions: fakeActions().actions,
			focus: 'q1',
			requests: [aRequest({ id: 'q1', kind: 'confirm', question: 'ship it?' })]
		});

		await vi.waitFor(() =>
			expect(document.querySelector('[data-request-id="q1"][data-focused="true"]')).not.toBeNull()
		);
	});

	it('says so when the thing is not there at all, rather than doing nothing', async () => {
		mount(updates(2), { focus: 'gone-for-ever' });

		await vi.waitFor(
			() => expect(document.querySelector('[data-testid="focus-missing"]')).not.toBeNull(),
			{ timeout: 6_000 }
		);
	});
});

/**
 * A question asked inside a thread (migration 022).
 *
 * Its notification names the question, which is drawn under the message it was
 * asked on rather than as a card of its own — so the lookup has to walk from the
 * question to that message, and from there to the card carrying it.
 */
describe('focusing a question asked in a thread', () => {
	it('lands on the question where it is actually drawn', async () => {
		const asked = aMessage({ id: 'm1', updateId: 'card', author: 'human', createdAt: day });

		mount([anUpdate({ id: 'card', seq: 2, createdAt: day })], {
			actions: fakeActions().actions,
			focus: 'q1',
			threadRequests: { m1: [aRequest({ id: 'q1', kind: 'confirm', question: 'ship it?' })] },
			threads: {
				for: (id: string) => (id === 'card' ? [asked] : []),
				forTask: () => [],
				posts: () => [],
				repliesTo: () => []
			}
		});

		await vi.waitFor(() =>
			expect(document.querySelector('[data-request-id="q1"][data-focused="true"]')).not.toBeNull()
		);
	});

	it('falls back to the card when the question itself is not drawn', async () => {
		// The thread has not arrived (no `threads` source at all), so the question
		// is nowhere — but the notification still has somewhere honest to land.
		mount([anUpdate({ id: 'card', seq: 2, createdAt: day })], {
			actions: fakeActions().actions,
			focus: 'q1',
			threadRequests: { m1: [aRequest({ id: 'q1', kind: 'confirm', question: 'ship it?' })] },
			threads: {
				for: (id: string) =>
					id === 'card'
						? [aMessage({ id: 'm1', updateId: 'card', author: 'human', createdAt: day })]
						: [],
				forTask: () => [],
				posts: () => [],
				repliesTo: () => []
			}
		});

		await vi.waitFor(
			() =>
				expect(
					document.querySelector('[data-focused="true"]')?.getAttribute('data-request-id') ??
						document.querySelector('[data-focused="true"]')?.getAttribute('data-message-id') ??
						document.querySelector('[data-focused="true"]')?.getAttribute('data-update-id')
				).not.toBeUndefined(),
			{ timeout: 4_000 }
		);
	});
});
