/**
 * The owner's messages on their way to the server, announced to whoever shows them.
 *
 * Every post and reply this tab writes goes through `ownerActions().postMessage`,
 * which tells this hub when it starts, what the server stored, or that it
 * failed. The thread store listens, so the owner's words show the moment they
 * are sent and the server's copy replaces them as soon as the write answers —
 * without waiting for the stream to echo it back.
 *
 * The stream still brings it to every other tab, and to this one: the store
 * reconciles by id, so the echo replaces the copy rather than doubling it.
 * Waiting for the echo alone was the bug: a laptop just woken, or a tab the
 * browser throttled, can hold a dead connection for a while, and the owner had
 * to reload to see their own reply.
 */
import type { NewMessage } from './actions';
import type { MessageView } from './types';

/** One message on its way: what was asked for, under a ticket for this tab. */
export type Sending = { ticket: string; input: NewMessage; at: number };

export type OutgoingListener = {
	sending(message: Sending): void;
	sent(ticket: string, message: MessageView): void;
	failed(ticket: string): void;
};

export class OutgoingMessages {
	#listeners = new Set<OutgoingListener>();
	#next = 0;

	/** Hear every send from now on. Returns the way to stop. */
	listen(listener: OutgoingListener): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	/** A send is starting. Returns its ticket. */
	begin(input: NewMessage): string {
		const ticket = `t${(this.#next += 1)}`;
		const message: Sending = { ticket, input, at: Date.now() };
		for (const listener of [...this.#listeners]) listener.sending(message);
		return ticket;
	}

	/** The server stored it: this is the row, as `GET /api/messages` would give it. */
	sent(ticket: string, message: MessageView): void {
		for (const listener of [...this.#listeners]) listener.sent(ticket, message);
	}

	/** It did not land. Whoever drew it takes it away; the box that sent it keeps the words. */
	failed(ticket: string): void {
		for (const listener of [...this.#listeners]) listener.failed(ticket);
	}
}

/** What a line's id starts with while it is still on its way to the server. */
export const SENDING_PREFIX = 'sending:';

/** Whether this line is the owner's, still on its way: drawn faded, with nothing to do to it yet. */
export function isSending(messageId: string): boolean {
	return messageId.startsWith(SENDING_PREFIX);
}

/** The tab's one hub. Tests construct their own. */
export const outgoing = new OutgoingMessages();
