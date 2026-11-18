import { describe, expect, it, vi } from 'vitest';
import { EventBus } from './bus';
import { Shutdown } from './shutdown';

describe('stopping the server', () => {
	it('fires its signal and lets parked waits go, once however often it is asked', async () => {
		const bus = new EventBus({ boot: 'b1' });
		const shutdown = new Shutdown(bus);
		const parked = bus.waitFor({ timeoutMs: 60_000 });
		const heard = vi.fn();
		shutdown.signal.addEventListener('abort', heard);

		shutdown.begin();
		shutdown.begin();

		expect(shutdown.signal.aborted).toBe(true);
		expect(heard).toHaveBeenCalledTimes(1);
		await expect(parked).resolves.toBeUndefined();
	});

	it('stops each background job it was handed when the server has closed', () => {
		const shutdown = new Shutdown(new EventBus({ boot: 'b1' }));
		const stop = vi.fn();
		const failing = vi.fn(() => {
			throw new Error('already stopped');
		});
		shutdown.adopt(failing);
		shutdown.adopt(stop);

		shutdown.finish();

		expect(failing).toHaveBeenCalledTimes(1);
		expect(stop).toHaveBeenCalledTimes(1);
	});
});
