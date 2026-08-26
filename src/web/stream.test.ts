import { describe, expect, it } from 'vitest';
import { DirectLink, EVENT_TYPES, SharedStream, type StreamMessage } from './stream';
import { Presence } from './presence.svelte';
import { Timeline } from './timeline.svelte';
import { FakeStream, aLiveAgent, aProject, anUpdate, fakeAgentsApi, fakeApi } from './testing';

/**
 * The tab's one connection, driven the way the server drives it.
 *
 * Everything here is about the *sharing*: how many connections exist, who is
 * handed which frame, and what happens at the edges of a consumer's life. What
 * a consumer then does with a frame is `timeline.test.ts` and
 * `presence.test.ts`.
 */

/** A hub over a `DirectLink` whose every opened connection the test can see. */
function hub() {
	const opened: string[] = [];
	const streams: FakeStream[] = [];
	const link = new DirectLink((url) => {
		const stream = new FakeStream();
		stream.url = url;
		opened.push(url);
		streams.push(stream);
		return stream;
	});
	return { stream: new SharedStream(link), opened, streams };
}

/** A consumer that records what it was handed. */
function consumer(types: readonly string[] = ['update.created']) {
	const seen: StreamMessage[] = [];
	let opens = 0;
	let errors = 0;
	return {
		seen,
		get opens() {
			return opens;
		},
		get errors() {
			return errors;
		},
		spec: {
			types,
			listener: (event: StreamMessage) => void seen.push(event),
			onOpen: () => void (opens += 1),
			onError: () => void (errors += 1)
		}
	};
}

describe('one connection per tab', () => {
	it('opens a single connection however many consumers subscribe', () => {
		const { stream, opened } = hub();

		stream.subscribe(consumer(['update.created']).spec);
		stream.subscribe(consumer(['agent.presence']).spec);
		stream.subscribe(consumer(['task.created']).spec);

		expect(opened).toEqual(['/api/stream']);
	});

	it('resumes from the newest seq any consumer was hydrated to', () => {
		const { stream, opened } = hub();

		stream.subscribe({ ...consumer().spec, cursor: 41 });

		expect(opened).toEqual(['/api/stream?last_event_id=41']);
	});

	it('hands each consumer only the event types it asked for', () => {
		const { stream, streams } = hub();
		const feed = consumer(['update.created', 'resync']);
		const rail = consumer(['agent.presence', 'resync']);
		stream.subscribe(feed.spec);
		stream.subscribe(rail.spec);

		streams[0].emit('update.created', { seq: 12, payload: { updateId: 'u1' } });
		streams[0].emit('agent.presence', { seq: 13, payload: { agentId: 'a1' } });
		streams[0].emit('resync', { seq: 14 });

		expect(feed.seen.map((event) => event.type)).toEqual(['update.created', 'resync']);
		expect(rail.seen.map((event) => event.type)).toEqual(['agent.presence', 'resync']);
		// The payload arrives verbatim: a consumer parses the server's own frame.
		expect(JSON.parse(feed.seen[0].data)).toMatchObject({ seq: 12, payload: { updateId: 'u1' } });
	});

	it('carries every event type the transport defines', () => {
		const { stream, streams } = hub();
		const all = consumer(EVENT_TYPES);
		stream.subscribe(all.spec);

		for (const [index, type] of EVENT_TYPES.entries()) streams[0].emit(type, { seq: index + 1 });

		expect(all.seen.map((event) => event.type)).toEqual([...EVENT_TYPES]);
	});

	it('forwards open and error to every consumer', () => {
		const { stream, streams } = hub();
		const feed = consumer();
		const rail = consumer(['agent.presence']);
		stream.subscribe(feed.spec);
		stream.subscribe(rail.spec);

		streams[0].fire('error');
		streams[0].fire('open');

		expect([feed.errors, feed.opens]).toEqual([1, 1]);
		expect([rail.errors, rail.opens]).toEqual([1, 1]);
	});
});

describe('when a consumer unmounts', () => {
	it('holds the connection open while another consumer still needs it', () => {
		const { stream, streams } = hub();
		const feed = stream.subscribe(consumer().spec);
		const rail = consumer(['agent.presence']);
		stream.subscribe(rail.spec);

		feed.close();

		expect(streams[0].closed).toBe(false);
		streams[0].emit('agent.presence', { seq: 5 });
		expect(rail.seen).toHaveLength(1);
	});

	it('closes the connection when the last consumer goes', () => {
		const { stream, streams } = hub();
		const feed = stream.subscribe(consumer().spec);
		const rail = stream.subscribe(consumer(['agent.presence']).spec);

		feed.close();
		rail.close();

		expect(streams[0].closed).toBe(true);
		expect(stream.subscribers).toBe(0);
	});

	it('leaves no listener on the connection it let go of', () => {
		const { stream, streams } = hub();
		const feed = stream.subscribe(consumer().spec);

		feed.close();

		expect(streams[0].listeners).toBe(0);
	});

	it('never hears from a connection it has let go of', () => {
		const { stream, streams } = hub();
		const feed = consumer();
		const held = stream.subscribe(feed.spec);
		held.close();

		streams[0].emit('update.created', { seq: 9 });

		expect(feed.seen).toEqual([]);
	});

	it('counts one unsubscribe per consumer however often it is called', () => {
		const { stream, streams } = hub();
		const feed = stream.subscribe(consumer().spec);
		stream.subscribe(consumer(['agent.presence']).spec);

		feed.close();
		feed.close();
		feed.close();

		expect(stream.subscribers).toBe(1);
		expect(streams[0].closed).toBe(false);
	});

	it('reconnects from the newest seq it saw when a consumer comes back', () => {
		const { stream, streams, opened } = hub();
		const first = stream.subscribe(consumer().spec);
		streams[0].emit('update.created', { seq: 12 });
		first.close();

		stream.subscribe(consumer().spec);

		expect(opened).toEqual(['/api/stream', '/api/stream?last_event_id=12']);
	});
});

describe('joining a stream that is already running', () => {
	it('tells a consumer it may have missed frames', () => {
		const { stream, streams } = hub();
		stream.subscribe({ ...consumer().spec, cursor: 10 });
		streams[0].emit('update.created', { seq: 12 });

		const late = stream.subscribe({ ...consumer(['agent.presence']).spec, cursor: 10 });

		expect(late.missed).toBe(true);
	});

	it('says nothing was missed by the consumer that opened it', () => {
		const { stream } = hub();

		expect(stream.subscribe({ ...consumer().spec, cursor: 10 }).missed).toBe(false);
	});

	it('says nothing was missed by a consumer that is already up to date', () => {
		const { stream, streams } = hub();
		stream.subscribe({ ...consumer().spec, cursor: 10 });
		streams[0].emit('update.created', { seq: 12 });

		const late = stream.subscribe({ ...consumer(['agent.presence']).spec, cursor: 12 });

		expect(late.missed).toBe(false);
	});
});

describe('when the browser cannot open a connection at all', () => {
	it('says so rather than throwing at the consumer', () => {
		const link = new DirectLink(() => {
			throw new Error('EventSource is not available');
		});
		const stream = new SharedStream(link);
		const feed = consumer();

		const held = stream.subscribe(feed.spec);

		expect(stream.connected).toBe(false);
		expect(feed.errors).toBe(1);
		held.close();
	});
});

describe('the two stores the shell mounts', () => {
	/** The shell, as `Shell.svelte` builds it: a timeline, a rail, one stream. */
	function shell() {
		const timelineApi = fakeApi({
			seq: 11,
			projects: [aProject()],
			items: [anUpdate({ id: 'u1', seq: 11 })]
		});
		const agentsApi = fakeAgentsApi({ seq: 11, agents: [aLiveAgent({ name: 'scout' })] });
		const opened: string[] = [];
		const streams: FakeStream[] = [];
		const stream = new SharedStream(
			new DirectLink((url) => {
				const source = new FakeStream();
				source.url = url;
				opened.push(url);
				streams.push(source);
				return source;
			})
		);
		const feed = new Timeline({
			stream,
			fetch: timelineApi.fetch,
			schedule: (run) => timelineApi.queue.push(run)
		});
		const presence = new Presence({
			stream,
			fetch: agentsApi.fetch,
			schedule: (run) => agentsApi.queue.push(run),
			clock: () => Date.UTC(2026, 7, 25, 10),
			pollMs: 60_000,
			tickMs: 60_000
		});
		feed.hydrate(timelineApi.snapshot());
		return { timelineApi, agentsApi, opened, streams, feed, presence };
	}

	it('costs the tab one connection, not one each', () => {
		const { feed, presence, opened } = shell();

		feed.start();
		presence.start();

		// One request, resumed from the seq the page was server-rendered at.
		expect(opened).toEqual(['/api/stream?last_event_id=11']);
	});

	it('updates both of them live from that one connection', async () => {
		const { feed, presence, timelineApi, agentsApi, streams } = shell();
		feed.start();
		presence.start();
		await agentsApi.settle();

		timelineApi.publish(anUpdate({ id: 'u2', seq: 12, body: 'just landed' }));
		agentsApi.replace(
			[aLiveAgent({ name: 'scout' }), aLiveAgent({ agentId: 'a2', name: 'buildbot' })],
			13
		);
		streams[0].emit('update.created', { seq: 12, payload: { updateId: 'u2', projectId: 'p1' } });
		streams[0].emit('agent.presence', { seq: 13, payload: { agentId: 'a2' } });
		await timelineApi.settle();
		await agentsApi.settle();

		expect(feed.items.map((item) => item.id)).toEqual(['u2', 'u1']);
		expect(presence.online.map((agent) => agent.name)).toEqual(['scout', 'buildbot']);
	});

	it('keeps the rail connected when the timeline unmounts, and the other way about', async () => {
		const { feed, presence, agentsApi, streams } = shell();
		feed.start();
		presence.start();
		await agentsApi.settle();

		feed.stop();

		expect(streams[0].closed).toBe(false);
		agentsApi.replace([], 14);
		streams[0].emit('agent.presence', { seq: 14, payload: { agentId: 'a1' } });
		await agentsApi.settle();
		expect(presence.online).toEqual([]);

		presence.stop();

		expect(streams[0].closed).toBe(true);
		expect(streams[0].listeners).toBe(0);
	});

	it('closes the gap for a store that joined after a frame had gone by', async () => {
		const { feed, presence, timelineApi, agentsApi, streams } = shell();
		// The rail is on screen first and opens the stream; an update lands before
		// the timeline has taken its own hold.
		presence.start();
		await agentsApi.settle();
		timelineApi.publish(anUpdate({ id: 'u2', seq: 12, body: 'landed early' }));
		streams[0].emit('update.created', { seq: 12, payload: { updateId: 'u2', projectId: 'p1' } });
		timelineApi.calls.length = 0;

		feed.start();
		await timelineApi.settle();

		// The frame itself is gone, so the store reads its snapshot instead of
		// rendering a page that is quietly one update out of date.
		expect(timelineApi.calls).toEqual(['/api/snapshot?limit=50']);
		expect(feed.items.map((item) => item.id)).toEqual(['u2', 'u1']);
	});

	it('resyncs both stores from one frame', async () => {
		const { feed, presence, timelineApi, agentsApi, streams } = shell();
		feed.start();
		presence.start();
		await agentsApi.settle();
		timelineApi.calls.length = 0;
		agentsApi.calls.length = 0;

		// What the server sends when a reconnect lands outside the ring buffer.
		streams[0].emit('resync', { seq: 99 });
		await timelineApi.settle();
		await agentsApi.settle();

		expect(timelineApi.calls).toEqual(['/api/snapshot?limit=50']);
		expect(agentsApi.calls).toEqual(['/api/snapshot/agents']);
	});
});
