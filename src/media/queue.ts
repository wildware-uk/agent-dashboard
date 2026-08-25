/**
 * The in-process job queue derivatives are produced on (design §6 step 4).
 *
 * Three properties, and each one is a failure this pipeline would otherwise
 * have:
 *
 * - **Concurrency two.** `sharp` and `ffmpeg` are CPU-bound native work, and
 *   this is the same process that serves the dashboard. Two at a time is the
 *   design's number: enough that a big video does not block every screenshot
 *   behind it, few enough that a burst of uploads cannot starve the event loop.
 * - **A failing job never rejects.** `run` resolves an *outcome* — the job's
 *   value or the error it threw — because a background job nobody awaited
 *   rejecting is an unhandled rejection, and an unhandled rejection is how Node
 *   exits the process. "Surviving a single job failing without taking down the
 *   process" is therefore a property of this type rather than a discipline every
 *   caller has to remember.
 * - **One key, one run.** `submit` folds a repeat submission into the run
 *   already in flight, which is what makes `media.ready` fire exactly once even
 *   though the worker re-lists the pending rows on every tick and an upload may
 *   also submit its own media directly.
 *
 * It knows nothing about media: it takes functions. That is deliberate — the
 * concurrency rule is testable with gates and counters rather than with files.
 */

/** The design's number (§6 step 4). */
export const DEFAULT_CONCURRENCY = 2;

/**
 * How a job ended.
 *
 * A union rather than a rejection, so an ignored job is inert and a caller that
 * does care has to look at `ok` to get at the value.
 */
export type JobOutcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

export type JobQueueOptions = {
	/** Jobs in flight at once. Defaults to {@link DEFAULT_CONCURRENCY}. */
	concurrency?: number;
	/**
	 * Called with whatever a job threw, before the outcome is resolved.
	 * Defaults to logging: a job that fails silently is a media item that is
	 * mysteriously never ready.
	 */
	onError?: (error: unknown) => void;
};

export class JobQueue {
	readonly #concurrency: number;
	readonly #onError: (error: unknown) => void;
	/** Jobs waiting for a slot, oldest first. Each entry starts one job. */
	readonly #waiting: Array<() => void> = [];
	/** Keyed runs, so the same media cannot be processed twice at once. */
	readonly #inFlight = new Map<string, Promise<JobOutcome<unknown>>>();
	#running = 0;
	#idle: Array<() => void> = [];

	constructor(options: JobQueueOptions = {}) {
		this.#concurrency = Math.max(1, Math.trunc(options.concurrency ?? DEFAULT_CONCURRENCY));
		this.#onError =
			options.onError ?? ((error: unknown) => console.error('derivative job failed', error));
	}

	get concurrency(): number {
		return this.#concurrency;
	}

	/** Jobs running right now. */
	get running(): number {
		return this.#running;
	}

	/** Jobs accepted but not yet started. */
	get queued(): number {
		return this.#waiting.length;
	}

	/** Everything this queue still owes an answer for. */
	get size(): number {
		return this.#running + this.#waiting.length;
	}

	/** Is there a run in flight for this key? */
	has(key: string): boolean {
		return this.#inFlight.has(key);
	}

	/**
	 * Run a job when a slot is free.
	 *
	 * @returns its outcome. This promise never rejects.
	 */
	run<T>(job: () => T | Promise<T>): Promise<JobOutcome<T>> {
		return new Promise<JobOutcome<T>>((resolve) => {
			const start = async () => {
				this.#running += 1;
				try {
					resolve({ ok: true, value: await job() });
				} catch (error) {
					this.#onError(error);
					resolve({ ok: false, error });
				} finally {
					this.#running -= 1;
					this.#pump();
				}
			};

			// Started synchronously when there is room, so a caller that has just
			// submitted three jobs can observe two running and one queued.
			if (this.#running < this.#concurrency) void start();
			else this.#waiting.push(() => void start());
		});
	}

	/**
	 * Run a job unless one is already in flight for this key, in which case the
	 * caller joins that run and gets the same outcome.
	 *
	 * The key is released when the job body settles, so a later submission of the
	 * same key runs again — a retry is a normal thing to want.
	 */
	submit<T>(key: string, job: () => T | Promise<T>): Promise<JobOutcome<T>> {
		const existing = this.#inFlight.get(key);
		if (existing) return existing as Promise<JobOutcome<T>>;

		const promise = this.run(async () => {
			try {
				return await job();
			} finally {
				this.#inFlight.delete(key);
			}
		});

		this.#inFlight.set(key, promise as Promise<JobOutcome<unknown>>);
		return promise;
	}

	/** Resolves when nothing is running and nothing is waiting. */
	onIdle(): Promise<void> {
		if (this.size === 0) return Promise.resolve();
		return new Promise<void>((resolve) => this.#idle.push(resolve));
	}

	/** Start the next job, or announce that the queue has gone quiet. */
	#pump(): void {
		const next = this.#waiting.shift();
		if (next) {
			next();
			return;
		}
		if (this.#running > 0) return;

		const waiting = this.#idle;
		this.#idle = [];
		for (const resolve of waiting) resolve();
	}
}
