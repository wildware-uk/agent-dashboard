/**
 * The pipeline: what decides *which* media gets derived, and when
 * (design §6 steps 4-5, §11 step 10).
 *
 * `./derive.ts` does one media item and `./queue.ts` runs two at a time; this
 * puts them together and answers the question neither of them can — where does
 * the work come from?
 *
 * **It comes from the table, not from the upload.** Every tick lists the rows
 * that are still `pending` with bytes on disk and submits them. That one choice
 * is why this slice can be added to a deployment that already has a backlog:
 * media uploaded before the pipeline existed is, by definition, exactly the set
 * this query returns. The alternative — enqueueing from `ingest` — would only
 * ever process uploads that happened after the code shipped, and would lose the
 * queue on every restart.
 *
 * Three properties fall out of doing it that way:
 *
 * - **Idempotent.** `processMedia` skips a row that is already `ready` and the
 *   queue folds a repeat submission of the same id into the run in flight, so
 *   overlapping ticks cannot double-process and `media.ready` still fires
 *   exactly once per media.
 * - **Self-healing.** A restart mid-transcode leaves the row `pending`, and the
 *   next tick picks it up.
 * - **Bounded.** One batch per tick, two jobs at a time. A neglected data
 *   directory is drained steadily rather than in one burst that starves the
 *   dashboard it is running inside.
 *
 * `processPendingMedia` is the same pass as a one-shot that resolves when the
 * work is done — the operator's handle, and what the tests drive.
 */
import { getDatabase, listMediaByStatus, type Db } from '$db';
import { bus as defaultBus, type EventBus } from '$events';
import { processMedia, type DeriveOptions, type DeriveOutcome } from './derive';
import { JobQueue, type JobOutcome } from './queue';
import { mediaSettings, type MediaSettings } from './settings';

/** Most media one pass will take on. */
export const DERIVATIVE_BATCH = 50;

/**
 * How often the background worker looks for work.
 *
 * The design's success criterion is that an agent's screenshot appears in an
 * open browser "within one second" (§1). The upload itself, the derive and the
 * SSE push all take time, so the polling interval is the part of that budget
 * this file controls: short enough not to be the reason a placeholder lingers,
 * long enough that an idle deployment is doing one indexed `SELECT` a second.
 */
export const WORKER_INTERVAL_MS = 1_000;

/** The seam tests replace. Production always uses {@link processMedia}. */
export type DeriveFn = (settings: MediaSettings, options: DeriveOptions) => Promise<DeriveOutcome>;

export type PipelineOptions = {
	db: Db;
	settings: MediaSettings;
	/** Defaults to the application bus. */
	bus?: EventBus;
	/** Jobs at once. Defaults to the queue's two (design §6). */
	concurrency?: number;
	onError?: (error: unknown) => void;
	/** Injected by tests to control timing without real ffmpeg runs. */
	derive?: DeriveFn;
};

/**
 * A queue bound to one database and data directory.
 *
 * Held for the life of the process by {@link startDerivativeWorker}, so the same
 * queue — and therefore the same "one run per media id" guarantee — spans every
 * tick.
 */
export class DerivativePipeline {
	readonly #queue: JobQueue;
	readonly #options: PipelineOptions;
	readonly #derive: DeriveFn;

	constructor(options: PipelineOptions) {
		this.#options = options;
		this.#derive = options.derive ?? processMedia;
		this.#queue = new JobQueue({
			concurrency: options.concurrency,
			onError: options.onError ?? ((error) => console.error('media derivative job failed', error))
		});
	}

	get concurrency(): number {
		return this.#queue.concurrency;
	}

	get running(): number {
		return this.#queue.running;
	}

	get queued(): number {
		return this.#queue.queued;
	}

	/**
	 * Submit one media item, or join the run already in flight for it.
	 *
	 * `force` applies to the run this call *starts*; a forced submit that joins an
	 * unforced run in flight gets that run's outcome, because the alternative is
	 * two `sharp` processes writing the same file.
	 */
	submit(id: string, options: { force?: boolean } = {}): Promise<JobOutcome<DeriveOutcome>> {
		return this.#queue.submit(id, () =>
			this.#derive(this.#options.settings, {
				db: this.#options.db,
				id,
				bus: this.#options.bus ?? defaultBus,
				force: options.force
			})
		);
	}

	/**
	 * Submit every media item still waiting for derivatives.
	 *
	 * @returns the ids submitted by this pass, oldest first. An id already in
	 *   flight is included — it is what the caller asked about — but it does not
	 *   start a second run.
	 */
	enqueuePending(options: { limit?: number } = {}): string[] {
		return this.submitPending(options).ids;
	}

	/**
	 * {@link enqueuePending}, keeping hold of the outcomes.
	 *
	 * Separate because a caller that wants to *wait* must take the promise from
	 * the same call that created the job: submitting again afterwards would race
	 * a job that had already finished and released its key.
	 */
	submitPending(options: { limit?: number } = {}): {
		ids: string[];
		outcomes: Promise<JobOutcome<DeriveOutcome>>[];
	} {
		const pending = listMediaByStatus(this.#options.db, {
			statuses: ['pending'],
			// A reservation whose PUT never happened has nothing to derive from.
			hasBytes: true,
			limit: options.limit ?? DERIVATIVE_BATCH
		});

		const ids: string[] = [];
		const outcomes: Promise<JobOutcome<DeriveOutcome>>[] = [];
		for (const media of pending) {
			ids.push(media.id);
			outcomes.push(this.submit(media.id));
		}
		return { ids, outcomes };
	}

	/** Resolves when the queue has drained. */
	onIdle(): Promise<void> {
		return this.#queue.onIdle();
	}

	/** Alias of {@link onIdle}, for callers that read as "wait for the work". */
	drain(): Promise<void> {
		return this.#queue.onIdle();
	}
}

/** What one pass did. */
export type PendingResult = {
	/** Media submitted. */
	submitted: number;
	/** Media that finished with derivatives and a `ready` row. */
	ready: number;
	/** Media whose reason is now on disk and in the log. */
	failed: number;
	/** Media that needed nothing doing — already `ready`, or bytes gone. */
	skipped: number;
};

export type PendingInput = {
	db: Db;
	bus?: EventBus;
	limit?: number;
	concurrency?: number;
	onError?: (error: unknown) => void;
};

/**
 * Derive everything that is waiting, and resolve when it is done.
 *
 * **This is the operator's handle on a backlog** — media uploaded before this
 * slice existed, or left behind by a crash mid-transcode. It is also what the
 * background worker does on a timer, so running it by hand and letting the
 * worker get there are the same code path.
 *
 * Never rejects for a bad file: a failure is one increment of `failed`.
 */
export async function processPendingMedia(
	settings: MediaSettings,
	input: PendingInput
): Promise<PendingResult> {
	const pipeline = new DerivativePipeline({
		db: input.db,
		settings,
		bus: input.bus,
		concurrency: input.concurrency,
		onError: input.onError
	});

	const submitted = pipeline.submitPending({ limit: input.limit });
	const outcomes = await Promise.all(submitted.outcomes);
	await pipeline.drain();

	const tally: PendingResult = { submitted: submitted.ids.length, ready: 0, failed: 0, skipped: 0 };
	for (const outcome of outcomes) {
		// `submit` resolves an outcome rather than rejecting, so a thrown job is
		// still counted rather than lost.
		if (!outcome.ok) tally.failed += 1;
		else if (outcome.value.status === 'ready') tally.ready += 1;
		else if (outcome.value.status === 'failed') tally.failed += 1;
		else tally.skipped += 1;
	}
	return tally;
}

export type WorkerOptions = {
	intervalMs?: number;
	limit?: number;
	concurrency?: number;
	/** Resolved on the first tick, not at boot. Defaults to the shared handle. */
	db?: () => Db;
	/** Resolved on the first tick, not at boot. Defaults to the environment. */
	settings?: () => MediaSettings;
	bus?: EventBus;
	onError?: (error: unknown) => void;
	/** Called with the ids a tick submitted. Defaults to a log line when non-empty. */
	onSweep?: (ids: readonly string[]) => void;
};

/**
 * Run the pipeline for the life of the process.
 *
 * Started by `src/hooks.server.ts`, alongside the two sweepers. The shape
 * follows `startMediaSweeper` in `$domain` deliberately, with one difference:
 * the database handle and settings are resolved on the **first tick and then
 * kept**, because the queue has to outlive a tick for "one run per media id" to
 * mean anything. Resolving late still gives the property that matters — a
 * deployment with a broken environment logs a failed sweep rather than failing
 * to boot.
 *
 * Every error is caught. An unhandled rejection from a background timer would
 * take the whole dashboard down to fail one thumbnail.
 *
 * @returns a function that stops it.
 */
export function startDerivativeWorker(options: WorkerOptions = {}): () => void {
	const {
		intervalMs = WORKER_INTERVAL_MS,
		limit,
		concurrency,
		db: getDb = getDatabase,
		settings: getSettings = mediaSettings,
		bus,
		onError = (error: unknown) => console.error('media derivative sweep failed', error),
		onSweep = (ids: readonly string[]) => {
			if (ids.length > 0) console.info(`deriving ${ids.length} media item(s)`);
		}
	} = options;

	let pipeline: DerivativePipeline | undefined;
	let stopped = false;

	const tick = () => {
		if (stopped) return;
		try {
			pipeline ??= new DerivativePipeline({
				db: getDb(),
				settings: getSettings(),
				bus,
				concurrency,
				onError
			});
			onSweep(pipeline.enqueuePending({ limit }));
		} catch (error) {
			onError(error);
		}
	};

	const timer = setInterval(tick, intervalMs);
	// A pending sweep must not keep the process alive at shutdown.
	timer.unref?.();

	// The first pass is scheduled rather than immediate: this is called at module
	// scope from `hooks.server.ts`, and opening the database there would move a
	// boot failure into an import.
	const first = setTimeout(tick, 0);
	first.unref?.();

	return () => {
		stopped = true;
		clearTimeout(first);
		clearInterval(timer);
	};
}
