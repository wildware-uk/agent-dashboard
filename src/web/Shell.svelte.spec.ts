import { render } from 'vitest-browser-svelte';
import { describe, expect, it, vi } from 'vitest';
import Shell from './Shell.svelte';
import { Presence } from './presence.svelte';
import { Timeline } from './timeline.svelte';
import { Tasks } from './tasks.svelte';
import {
	FakeStream,
	aLiveAgent,
	aMedia,
	aProject,
	aTask,
	anAck,
	aMessage,
	anUpdate,
	fakeAgentsApi,
	fakeApi,
	fakeTasksApi
} from './testing';

/**
 * The shell as a whole. Responsive behaviour is CSS, and no stylesheet is loaded
 * here, so the layout itself is asserted by `shell.e2e.ts` at 375px in a real
 * page; what this covers is that all three regions and the drawer exist and are
 * wired to the store.
 */
function mount(project: string | null = null) {
	const api = fakeApi({ seq: 4, projects: [aProject()], items: [anUpdate({ body: 'hello' })] });
	const stream = new FakeStream();
	const feed = new Timeline({
		fetch: api.fetch,
		openStream: () => stream,
		schedule: (run) => api.queue.push(run)
	});
	return { api, stream, feed, screen: render(Shell, { snapshot: api.snapshot(), project, feed }) };
}

describe('the three regions', () => {
	it('renders the sidebar, the timeline and the rail', async () => {
		const { screen } = mount();

		await expect.element(screen.getByRole('navigation', { name: 'Projects' })).toBeInTheDocument();
		await expect.element(screen.getByLabelText('Update timeline')).toBeInTheDocument();
		expect(document.querySelector('[data-rail]')).not.toBeNull();
	});

	it('paints the server-rendered timeline rather than an empty shell', async () => {
		const { screen } = mount();

		await expect.element(screen.getByText('hello')).toBeInTheDocument();
	});

	it('opens the stream on mount and closes it on unmount', async () => {
		const { stream, screen } = mount();

		expect(stream.closed).toBe(false);
		screen.unmount();

		expect(stream.closed).toBe(true);
	});

	it('names the selected project in the header', async () => {
		const { screen } = mount('agent-dashboard');

		await expect
			.element(screen.getByRole('heading', { name: 'Agent Dashboard' }))
			.toBeInTheDocument();
	});
});

/**
 * A ULID, as the server actually mints agent ids. The literal matters: every one
 * of them begins `01` until September 2039, which is why a card that shows an id
 * says nothing about who posted it (#20).
 */
const AGENT_ULID = '01M0X5XHT67FCP294SSA3B2XHV';

/**
 * The shell with both of its stores faked: the timeline snapshot that carries
 * the agent names, and the presence endpoint that keeps them live.
 */
function mountWithAgents(options: {
	agentNames?: Record<string, string>;
	agents?: ReturnType<typeof aLiveAgent>[];
}) {
	const api = fakeApi({
		seq: 4,
		projects: [aProject()],
		items: [anUpdate({ agentId: AGENT_ULID, body: 'shipped it' })],
		agentNames: options.agentNames ?? {}
	});
	const agentsApi = fakeAgentsApi({ seq: 4, agents: options.agents ?? [] });
	const feed = new Timeline({
		fetch: api.fetch,
		openStream: () => new FakeStream(),
		schedule: (run) => api.queue.push(run)
	});
	const presence = new Presence({
		fetch: agentsApi.fetch,
		openStream: () => new FakeStream(),
		schedule: (run) => agentsApi.queue.push(run)
	});

	return {
		agentsApi,
		card: () => document.querySelector('article')?.textContent ?? '',
		screen: render(Shell, { snapshot: api.snapshot(), feed, presence })
	};
}

describe('attributing the cards', () => {
	it('names the poster from the snapshot, for an agent that is nowhere near online', async () => {
		// Nobody is beating, so presence knows nothing — and this is the common
		// case, because a timeline is mostly the work of agents that have gone.
		const { card } = mountWithAgents({ agentNames: { [AGENT_ULID]: 'docs-writer' } });

		await expect.poll(card).toContain('docs-writer');
		expect(card()).not.toContain(AGENT_ULID);
	});

	it('names an agent that registered a session after the page was rendered', async () => {
		const { card, agentsApi } = mountWithAgents({
			agents: [aLiveAgent({ agentId: AGENT_ULID, name: 'build-bot', lastHeartbeatAt: Date.now() })]
		});

		// Before presence answers there is no name to be had, and the card says
		// something readable rather than 26 characters.
		expect(card()).toContain('agent-3b2xhv');

		await agentsApi.settle();

		// No reload, no second snapshot: the rail's read is what named it.
		await expect.poll(card).toContain('build-bot');
	});
});

/**
 * The live swap, end to end in one page (design §6 step 5, §7).
 *
 * This is the criterion the feature exists for and the one easiest to fake, so
 * it is asserted through the whole shell rather than on a component: a real
 * store, the fake `/api/snapshot` pair the other specs use, and a `media.ready`
 * frame delivered exactly as the server serialises it. Nothing here reloads,
 * remounts or re-renders the page — proved by holding on to the card's own DOM
 * node across the swap.
 */
describe('media becoming ready while the page is open', () => {
	const pending = aMedia({
		id: 'm1',
		updateId: 'u1',
		status: 'pending',
		width: null,
		height: null,
		variants: []
	});
	const ready = aMedia({ id: 'm1', updateId: 'u1' });

	function mountWithMedia() {
		const card = anUpdate({ id: 'u1', seq: 4, body: 'a screenshot', media: [pending] });
		const api = fakeApi({ seq: 4, projects: [aProject()], items: [card] });
		const stream = new FakeStream();
		const feed = new Timeline({
			fetch: api.fetch,
			openStream: () => stream,
			schedule: (run) => api.queue.push(run)
		});
		return { api, stream, card, screen: render(Shell, { snapshot: api.snapshot(), feed }) };
	}

	it('turns the placeholder into the image with no reload', async () => {
		const { api, stream, card, screen } = mountWithMedia();

		// What the owner sees the moment the update lands: a sized placeholder,
		// because the pipeline has not run yet.
		await expect.element(screen.getByText('Processing…')).toBeInTheDocument();
		expect(document.querySelector('[data-media-grid] img')).toBeNull();
		const article = document.querySelector('article');

		// The derivative job finishes and the server publishes (design §6 step 5).
		api.replace({ items: [{ ...card, media: [ready] }], seq: 5 });
		stream.emit('media.ready', {
			seq: 5,
			payload: { mediaId: 'm1', updateId: 'u1', kind: 'image' }
		});
		await api.settle();

		await expect
			.poll(() => document.querySelector('[data-media-grid] img')?.getAttribute('src'))
			.toBe('/media/m1/thumb-640');
		expect(document.body.textContent).not.toContain('Processing…');
		// The same card, still mounted: this was a swap, not a re-render of the page.
		expect(document.querySelector('article')).toBe(article);
	});

	it('leaves the card where it is: an image arriving is not a new update', async () => {
		const { api, stream, card } = mountWithMedia();
		const before = document.querySelectorAll('article').length;

		api.replace({ items: [{ ...card, media: [ready] }], seq: 5 });
		stream.emit('media.ready', {
			seq: 5,
			payload: { mediaId: 'm1', updateId: 'u1', kind: 'image' }
		});
		await api.settle();

		await expect.poll(() => document.querySelector('[data-media-grid] img') !== null).toBe(true);
		expect(document.querySelectorAll('article')).toHaveLength(before);
		// No "1 new" pill: nothing arrived, one card changed.
		expect(document.body.textContent).not.toContain('new update');
	});
});

describe('the mobile drawer', () => {
	it('is closed until it is asked for', async () => {
		const { screen } = mount();

		await expect
			.element(screen.getByRole('button', { name: 'Open projects' }))
			.toHaveAttribute('aria-expanded', 'false');
		expect(document.querySelector('[role="dialog"]')).toBeNull();
	});

	it('opens as a labelled panel with the project list in it', async () => {
		const { screen } = mount();

		await screen.getByRole('button', { name: 'Open projects' }).click();

		await expect.element(screen.getByRole('dialog', { name: 'Projects' })).toBeInTheDocument();
	});

	it('closes on Escape, because that is what a drawer does', async () => {
		const { screen } = mount();
		await screen.getByRole('button', { name: 'Open projects' }).click();

		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

		await expect.element(screen.getByRole('dialog')).not.toBeInTheDocument();
	});

	it('closes when a project in it is followed', async () => {
		const { screen } = mount();
		await screen.getByRole('button', { name: 'Open projects' }).click();

		// Two sidebars are mounted at once — the permanent one and the drawer's —
		// so this deliberately clicks the link inside the dialog.
		const link = document.querySelector('[role="dialog"] a[href="/projects/agent-dashboard"]');
		(link as HTMLElement).click();

		await expect.element(screen.getByRole('dialog')).not.toBeInTheDocument();
	});
});

/**
 * Per-project styling in the header (design §7).
 *
 * The wordmark case is the one with an accessibility trap in it: a logo standing
 * in for the name must not take the name out of the accessible tree with it.
 */
describe('a project’s own styling', () => {
	function mountThemed(theme: Record<string, unknown> | null) {
		const project = aProject({ slug: 'dash', name: 'Mega Merge', theme });
		const api = fakeApi({ seq: 4, projects: [project], items: [anUpdate({ body: 'hello' })] });
		const feed = new Timeline({
			fetch: api.fetch,
			openStream: () => new FakeStream(),
			schedule: (run) => api.queue.push(run)
		});
		return render(Shell, { snapshot: api.snapshot(), project: 'dash', feed });
	}

	it('writes the project’s colours as custom properties on the shell', async () => {
		mountThemed({ background: '#101820', accent: '#ffb300' });

		const shell = document.querySelector('[data-themed="true"]') as HTMLElement;
		expect(shell.style.getPropertyValue('--surface')).toBe('#101820');
		expect(shell.style.getPropertyValue('--accent')).toBe('#ffb300');
		// Derived, not asked for: whatever the background is, the text is readable.
		expect(shell.style.getPropertyValue('--content')).not.toBe('');
	});

	it('marks nothing themed for a project without one', async () => {
		mountThemed(null);

		expect(document.querySelector('[data-themed="true"]')).toBeNull();
	});

	it('shows a logo beside the name, decoratively', async () => {
		const screen = mountThemed({ logoMediaId: 'm1' });

		const logo = screen.getByTestId('project-logo').element();
		expect(logo.getAttribute('alt')).toBe('');
		await expect.element(screen.getByRole('heading', { name: 'Mega Merge' })).toBeInTheDocument();
	});

	it('lets the logo stand in for the name, keeping the name as its alt text', async () => {
		const screen = mountThemed({ logoMediaId: 'm1', logoReplacesName: true });

		const logo = screen.getByTestId('project-logo').element();
		expect(logo.getAttribute('alt')).toBe('Mega Merge');
		expect(logo.getAttribute('data-wordmark')).toBe('true');
		// The heading goes, but the name has not left the page.
		await expect
			.element(screen.getByRole('heading', { name: 'Mega Merge' }))
			.not.toBeInTheDocument();
	});

	it('keeps the heading when the flag arrives without a logo', async () => {
		// The server refuses this pairing, so it can only come from a stale payload
		// — and a header with neither a logo nor a title would have no name at all.
		const screen = mountThemed({ logoReplacesName: true });

		await expect.element(screen.getByRole('heading', { name: 'Mega Merge' })).toBeInTheDocument();
	});
});

/**
 * The two views of one project (design §7).
 *
 * The feed is "what happened" and the board is "what is being worked on". They
 * are two ways of looking at one project rather than two halves of one screen,
 * so each gets the whole centre column and the owner picks.
 */
describe('the feed and the board', () => {
	function withBoard(view: 'feed' | 'board' = 'feed') {
		const api = fakeApi({ seq: 4, projects: [aProject()], items: [anUpdate({ body: 'hello' })] });
		const stream = new FakeStream();
		const feed = new Timeline({
			fetch: api.fetch,
			openStream: () => stream,
			schedule: (run) => api.queue.push(run)
		});
		const taskApi = fakeTasksApi({ tasks: [aTask({ id: 't7', state: 'todo', title: 'Queued' })] });
		const tasks = new Tasks({ fetch: taskApi.fetch, openStream: () => new FakeStream() });
		const remember = { view: () => null, set: vi.fn() };

		return {
			remember,
			screen: render(Shell, {
				snapshot: api.snapshot(),
				project: 'agent-dashboard',
				feed,
				tasks,
				view,
				remember
			})
		};
	}

	it('opens on the feed, with the board one tab away', async () => {
		const { screen } = withBoard();

		await expect.element(screen.getByLabelText('Update timeline')).toBeInTheDocument();
		expect(document.querySelector('[data-testid="board"]')).toBeNull();
		await expect.element(screen.getByTestId('tab-feed')).toHaveAttribute('aria-selected', 'true');
	});

	it('swaps the whole column for the board, and says which tab is on', async () => {
		const { screen, remember } = withBoard();

		await screen.getByTestId('tab-board').click();

		await expect.element(screen.getByTestId('board')).toBeInTheDocument();
		// The feed is not underneath it: the board is a view, not a strip.
		expect(document.querySelector('[data-timeline]')).toBeNull();
		await expect.element(screen.getByTestId('tab-board')).toHaveAttribute('aria-selected', 'true');
		expect(remember.set).toHaveBeenCalledWith('board');
	});

	it('opens straight onto the board when that is what this browser last chose', async () => {
		const { screen } = withBoard('board');

		await expect.element(screen.getByTestId('board')).toBeInTheDocument();
	});

	it('goes back to the feed when a card on the board is picked, having filtered it', async () => {
		const { screen } = withBoard('board');

		await screen.getByTestId('board-task').click();

		// Filtering a feed nobody is looking at is a click that appeared to do
		// nothing, so the tab follows the filter.
		await expect.element(screen.getByLabelText('Update timeline')).toBeInTheDocument();
		await expect.element(screen.getByTestId('tab-feed')).toHaveAttribute('aria-selected', 'true');
	});
});

/**
 * Acknowledgements survive the server render (migration 013).
 *
 * This is the regression the feature actually shipped with: the store held the
 * acknowledgements and the component rendered them, and the shell forwarded the
 * snapshot's messages to the thread store **without** its acks — so a tick was
 * missing at first paint and appeared on the next refetch, which reads as the
 * agent having only just answered something it answered an hour ago.
 */
describe('what agents have said, at first paint', () => {
	function mountWithAcks() {
		const update = anUpdate({ id: 'u1', body: 'shipped it' });
		const api = fakeApi({
			seq: 9,
			projects: [aProject()],
			items: [update],
			messages: [aMessage({ id: 'm1', updateId: 'u1', body: 'have a look' })],
			acks: [anAck({ id: 'k1', messageId: 'm1', state: 'done', agentId: 'a1' })],
			agentNames: { a1: 'scout' }
		});
		const stream = new FakeStream();
		const feed = new Timeline({
			fetch: api.fetch,
			openStream: () => stream,
			schedule: (run) => api.queue.push(run)
		});
		return { api, screen: render(Shell, { snapshot: api.snapshot(), feed }) };
	}

	it('renders the tick from the server render, without waiting for a refetch', async () => {
		const { screen } = mountWithAcks();

		await expect.element(screen.getByText('scout marked this done')).toBeInTheDocument();
	});
});

/**
 * Where the composer lives (design §7).
 *
 * It was built on the board tab and that was the wrong place: the feed is the
 * screen the owner actually watches, and a composer they had to change tabs to
 * reach is one they would not use.
 */
describe('posting to the feed', () => {
	it('puts the composer at the top of the feed, inside the timeline panel', async () => {
		const { screen } = mount();

		await expect.element(screen.getByLabelText('Post to the feed')).toBeInTheDocument();
		const panel = document.querySelector('#panel-feed');
		expect(panel?.querySelector('[data-composer]')).not.toBeNull();
	});

	it('puts it above the timeline rather than inside the scroller', async () => {
		mount();

		// Inside the scroller it would leave the screen on a long day, which is
		// exactly when handing something over is most likely.
		const scroller = document.querySelector('[data-timeline]');
		expect(scroller?.querySelector('[data-composer]')).toBeNull();
		expect(document.querySelector('[data-composer]')).not.toBeNull();
	});

	it('is not on the board tab, which is for looking at work rather than filing it', async () => {
		const { screen } = mount();

		await screen.getByTestId('tab-board').click();

		await expect.element(screen.getByRole('tabpanel')).toBeInTheDocument();
		expect(document.querySelector('[data-composer]')).toBeNull();
	});
});

/**
 * Opening the projects with a swipe (design §7).
 *
 * The owner asked for a pull in from the left edge to open the project drawer
 * "instead of going back". Dispatched as real touch events here, because the
 * decision this is testing is the wiring — `swipe.test.ts` already asserts what
 * counts as a swipe.
 */
describe('the edge swipe', () => {
	/** One finger, from here to there. */
	function swipe(from: [number, number], to: [number, number]) {
		const point = (x: number, y: number) =>
			new Touch({ identifier: 1, target: document.body, clientX: x, clientY: y });

		window.dispatchEvent(
			new TouchEvent('touchstart', {
				bubbles: true,
				cancelable: true,
				touches: [point(...from)]
			})
		);
		window.dispatchEvent(
			new TouchEvent('touchend', {
				bubbles: true,
				cancelable: true,
				changedTouches: [point(...to)]
			})
		);
	}

	it('opens the projects on a pull in from the edge', async () => {
		const { screen } = mount();

		swipe([4, 400], [140, 405]);

		await expect.element(screen.getByRole('dialog', { name: 'Projects' })).toBeVisible();
	});

	it('leaves a drag that started mid-screen alone', async () => {
		const { screen } = mount();

		swipe([200, 400], [340, 405]);

		// Somebody dragging a wide code block sideways, which happens constantly.
		await expect.element(screen.getByRole('dialog', { name: 'Projects' })).not.toBeInTheDocument();
	});

	it('closes again on a pull back towards the edge', async () => {
		const { screen } = mount();
		swipe([4, 400], [140, 405]);
		await expect.element(screen.getByRole('dialog', { name: 'Projects' })).toBeVisible();

		swipe([200, 400], [40, 405]);

		await expect.element(screen.getByRole('dialog', { name: 'Projects' })).not.toBeInTheDocument();
	});
});
