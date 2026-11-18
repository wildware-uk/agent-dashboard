/**
 * Stopping the process promptly (systemd sends SIGTERM, then SIGKILLs at 90 s).
 *
 * The HTTP server will not close while a response is still open, and this one
 * holds responses open on purpose: every browser, phone and agent channel keeps
 * a live stream, and an agent waiting on its owner parks a call for up to a
 * minute. adapter-node waits for them (`SHUTDOWN_TIMEOUT`, 30 s) before cutting
 * them, and anything still holding the event loop after that kept the process
 * up until systemd killed it.
 *
 * So the server says it is stopping: `begin` (on SIGTERM) fires {@link signal},
 * which ends every live stream, and closes the bus, which lets every parked
 * wait go as a timeout. Clients reconnect to the next process as they would
 * after any drop. `finish` (once the HTTP server has closed) stops the
 * background jobs.
 */
import { EventBus, bus as sharedBus } from './bus';

export class Shutdown {
	readonly #controller = new AbortController();
	readonly #bus: EventBus;
	readonly #jobs: (() => void)[] = [];

	constructor(bus: EventBus = sharedBus) {
		this.#bus = bus;
	}

	/** Fires once, when the process starts stopping. Live streams end on it. */
	get signal(): AbortSignal {
		return this.#controller.signal;
	}

	/** Start stopping: end live streams and let parked waits go. Safe to call twice. */
	begin(): void {
		if (this.#controller.signal.aborted) return;
		this.#controller.abort();
		this.#bus.close();
	}

	/** A background job to stop once the server has closed. */
	adopt(stop: () => void): void {
		this.#jobs.push(stop);
	}

	/** The server has closed: stop every background job. One that throws doesn't stop the rest. */
	finish(): void {
		this.begin();
		for (const stop of this.#jobs.splice(0)) {
			try {
				stop();
			} catch {
				// Already stopped, or never started: either way it is not running.
			}
		}
	}
}

/** The process's one. Tests construct their own. */
export const shutdown = new Shutdown();
