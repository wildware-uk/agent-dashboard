import { describe, expect, it, vi } from 'vitest';
import { dismissable } from './dismiss';

/**
 * Closing a small panel (design §7).
 *
 * The owner: "clicking anywhere should dismiss the tag setting popup."
 */
function panel(options: Partial<Parameters<typeof dismissable>[1]> = {}) {
	const trigger = document.createElement('button');
	const node = document.createElement('div');
	const inside = document.createElement('span');
	node.append(inside);
	document.body.append(trigger, node);

	const onclose = vi.fn();
	const handle = dismissable(node, { onclose, ignore: trigger, ...options });

	return {
		trigger,
		node,
		inside,
		onclose,
		handle,
		cleanup: () => {
			handle.destroy();
			trigger.remove();
			node.remove();
		}
	};
}

const press = (target: Element) =>
	target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));

describe('pressing elsewhere', () => {
	it('closes the panel', () => {
		const p = panel();

		press(document.body);

		expect(p.onclose).toHaveBeenCalledTimes(1);
		p.cleanup();
	});

	it('leaves it alone for a press inside it', () => {
		const p = panel();

		press(p.inside);

		expect(p.onclose).not.toHaveBeenCalled();
		p.cleanup();
	});

	it('leaves the button that opened it alone, so the toggle still toggles', () => {
		// Without this the press would close the panel and the button's own click
		// would reopen it, which reads as the button having done nothing.
		const p = panel();

		press(p.trigger);

		expect(p.onclose).not.toHaveBeenCalled();
		p.cleanup();
	});
});

describe('the keyboard way out', () => {
	it('closes on Escape', () => {
		const p = panel();

		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

		expect(p.onclose).toHaveBeenCalledTimes(1);
		p.cleanup();
	});

	it('ignores every other key', () => {
		const p = panel();

		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));

		expect(p.onclose).not.toHaveBeenCalled();
		p.cleanup();
	});
});

describe('when it is not listening', () => {
	it('does nothing while disabled, and stops listening once destroyed', () => {
		const off = panel({ enabled: false });
		press(document.body);
		expect(off.onclose).not.toHaveBeenCalled();
		off.cleanup();

		const on = panel();
		on.handle.destroy();
		press(document.body);
		expect(on.onclose).not.toHaveBeenCalled();
		on.cleanup();
	});
});
