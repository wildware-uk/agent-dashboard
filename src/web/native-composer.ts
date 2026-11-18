/**
 * The iPhone app's own message bar, when the page is open inside the app.
 *
 * The app has a native text box along the bottom of the screen, so a Reply
 * pressed on the page hands over to it instead of opening a second box: the
 * owner: "pressing reply shouldn't show any text boxes on the phone, it should
 * use the integrated native text box." The page keeps the sending, because it
 * already knows where a reply goes (the card, the line being answered, the
 * question); the app only collects the words and hands them back.
 *
 * Absent outside the app, and in app builds from before it, which is how a page
 * served to an old build keeps its own boxes.
 */

type Send = (text: string) => Promise<void>;

type Handler = { postMessage(message: unknown): void };

type Bridge = {
	/** Called by the app with what the owner typed. Rejects with what went wrong. */
	send(id: string, text: string): Promise<void>;
};

declare global {
	interface Window {
		webkit?: { messageHandlers?: Record<string, Handler | undefined> };
		agentsComposer?: Bridge;
	}
}

const HANDLER = 'agentsComposer';

let pending: { id: string; send: Send } | null = null;
let counter = 0;

function handler(): Handler | undefined {
	return typeof window === 'undefined' ? undefined : window.webkit?.messageHandlers?.[HANDLER];
}

/** Whether a Reply should go to the app's bar rather than open a box on the page. */
export function hasNativeComposer(): boolean {
	return handler() !== undefined;
}

/**
 * Point the app's bar at one reply: it shows `label` above the bar and raises
 * the keyboard, starting from `draft` when there is a suggested answer. Only the
 * newest hand-over is live, as only one bar exists.
 *
 * @returns false outside the app, so the caller opens its own box instead.
 */
export function replyInApp(label: string, send: Send, draft = ''): boolean {
	const target = handler();
	if (!target) return false;
	installBridge();
	counter += 1;
	pending = { id: `reply-${counter}`, send };
	target.postMessage({ id: pending.id, label, draft });
	return true;
}

function installBridge(): void {
	if (window.agentsComposer) return;
	window.agentsComposer = {
		async send(id, text) {
			const current = pending;
			if (current === null || current.id !== id) {
				throw new Error('That reply has closed. Press Reply again.');
			}
			if (text.trim() === '') throw new Error('Nothing to send.');
			await current.send(text.trim());
			if (pending === current) pending = null;
		}
	};
}
