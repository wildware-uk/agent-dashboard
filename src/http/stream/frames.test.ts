import { describe, expect, it } from 'vitest';
import { EventBus } from '$events';
import {
	SSE_HEADERS,
	commentFrame,
	eventFrame,
	resyncFrame,
	retryFrame,
	RESYNC_EVENT
} from './frames';

const bus = new EventBus();
const event = bus.publish('update.created', { updateId: 'u1', projectId: 'p1', agentId: 'a1' });

describe('an event frame', () => {
	it('carries the global sequence as the SSE id (design §4)', () => {
		expect(eventFrame(event)).toMatch(new RegExp(`^id: ${event.seq}\\n`));
	});

	it('names the event type, so a client can listen per type', () => {
		expect(eventFrame(event)).toContain('event: update.created\n');
	});

	it('carries the whole envelope as JSON on one data line', () => {
		const data = eventFrame(event)
			.split('\n')
			.find((line) => line.startsWith('data: '))!
			.slice('data: '.length);

		expect(JSON.parse(data)).toEqual(event);
	});

	it('ends with the blank line that terminates a frame', () => {
		expect(eventFrame(event).endsWith('\n\n')).toBe(true);
	});
});

describe('a resync frame', () => {
	it('is a single event naming why the replay could not be served', () => {
		const frame = resyncFrame({ reason: 'expired', from: 3, seq: 900 });
		const lines = frame.trimEnd().split('\n');

		expect(lines[0]).toBe('id: 900');
		expect(lines[1]).toBe(`event: ${RESYNC_EVENT}`);
		expect(JSON.parse(lines[2].slice('data: '.length))).toEqual({
			type: 'resync',
			reason: 'expired',
			from: 3,
			seq: 900
		});
		expect(lines).toHaveLength(3);
	});

	it('omits the id when nothing has been published, so no cursor is invented', () => {
		expect(resyncFrame({ reason: 'ahead', from: 7, seq: 0 })).not.toContain('id:');
	});
});

describe('the framing details a proxy or a client can trip over', () => {
	it('writes a comment as a colon-prefixed frame', () => {
		expect(commentFrame('heartbeat')).toBe(': heartbeat\n\n');
	});

	it('strips newlines out of a comment, which would end the frame early', () => {
		expect(commentFrame('two\nlines')).toBe(': two lines\n\n');
	});

	it('tells the client how long to wait before reconnecting', () => {
		expect(retryFrame(2500)).toBe('retry: 2500\n\n');
	});

	it('asks proxies not to buffer, in the response as well as in nginx.conf', () => {
		expect(SSE_HEADERS['x-accel-buffering']).toBe('no');
		expect(SSE_HEADERS['content-type']).toMatch(/^text\/event-stream\b/);
		expect(SSE_HEADERS['cache-control']).toContain('no-transform');
	});
});
