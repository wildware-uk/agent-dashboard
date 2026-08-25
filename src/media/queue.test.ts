import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONCURRENCY, JobQueue } from './queue';

/** A promise plus the handles to settle it later, so a test controls when a job ends. */
function deferred<T = void>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe('JobQueue', () => {
	it('runs two jobs at once and makes the third wait (design §6)', async () => {
		const queue = new JobQueue();
		const gates = [deferred(), deferred(), deferred()];
		const started: number[] = [];

		const outcomes = gates.map((gate, index) =>
			queue.run(async () => {
				started.push(index);
				await gate.promise;
				return index;
			})
		);

		// Two are in flight, the third is behind them and has not been called.
		expect(started).toEqual([0, 1]);
		expect(queue.running).toBe(2);
		expect(queue.queued).toBe(1);

		gates[0].resolve();
		await outcomes[0];

		expect(started).toEqual([0, 1, 2]);
		expect(queue.running).toBe(2);
		expect(queue.queued).toBe(0);

		gates[1].resolve();
		gates[2].resolve();
		await Promise.all(outcomes);

		expect(queue.running).toBe(0);
	});

	it('defaults to the concurrency the design asks for', () => {
		expect(DEFAULT_CONCURRENCY).toBe(2);
		expect(new JobQueue().concurrency).toBe(2);
	});

	it('reports a thrown job as an outcome instead of rejecting', async () => {
		const onError = vi.fn();
		const queue = new JobQueue({ onError });
		const boom = new Error('sharp exploded');

		const outcome = await queue.run(() => {
			throw boom;
		});

		expect(outcome).toEqual({ ok: false, error: boom });
		expect(onError).toHaveBeenCalledWith(boom);
	});

	it('keeps draining after a job fails', async () => {
		// The point of the whole class: one bad file must not stop the pipeline,
		// and an unawaited rejection would take the process down with it.
		const queue = new JobQueue({ concurrency: 1, onError: () => {} });

		void queue.run(() => Promise.reject(new Error('corrupt')));
		const after = await queue.run(() => 'still here');

		expect(after).toEqual({ ok: true, value: 'still here' });
	});

	it('never rejects, so an ignored job cannot become an unhandled rejection', async () => {
		const queue = new JobQueue({ onError: () => {} });
		const rejected = queue.run(() => Promise.reject(new Error('ignored')));

		await expect(rejected).resolves.toMatchObject({ ok: false });
	});

	it('folds a repeat submission of the same key into the job already in flight', async () => {
		const queue = new JobQueue();
		const gate = deferred();
		const job = vi.fn(async () => {
			await gate.promise;
			return 'once';
		});

		const first = queue.submit('media-1', job);
		const second = queue.submit('media-1', job);

		expect(second).toBe(first);
		expect(queue.has('media-1')).toBe(true);
		expect(queue.queued).toBe(0);

		gate.resolve();
		expect(await first).toEqual({ ok: true, value: 'once' });
		expect(job).toHaveBeenCalledTimes(1);
		expect(queue.has('media-1')).toBe(false);
	});

	it('runs the same key again once the first run has finished', async () => {
		const queue = new JobQueue();
		const job = vi.fn(() => 'done');

		await queue.submit('media-1', job);
		await queue.submit('media-1', job);

		expect(job).toHaveBeenCalledTimes(2);
	});

	it('keeps distinct keys distinct', async () => {
		const queue = new JobQueue();
		const gate = deferred();

		const a = queue.submit('a', () => gate.promise);
		const b = queue.submit('b', () => gate.promise);

		expect(a).not.toBe(b);
		expect(queue.running).toBe(2);

		gate.resolve();
		await Promise.all([a, b]);
	});

	it('resolves onIdle when everything queued has finished', async () => {
		const queue = new JobQueue();
		const gate = deferred();
		const jobs = [1, 2, 3].map(() => queue.run(() => gate.promise));

		let idle = false;
		const waiting = queue.onIdle().then(() => {
			idle = true;
		});

		expect(idle).toBe(false);
		gate.resolve();
		await Promise.all(jobs);
		await waiting;

		expect(idle).toBe(true);
		expect(queue.size).toBe(0);
	});

	it('resolves onIdle immediately when there is nothing to wait for', async () => {
		await expect(new JobQueue().onIdle()).resolves.toBeUndefined();
	});
});
