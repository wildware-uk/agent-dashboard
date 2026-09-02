<script lang="ts">
	/**
	 * The conversation on one update, and the box the owner replies in (§7).
	 *
	 * The component renders from the messages it is handed and nothing else — no
	 * fetching, no store — so it is the same component whether the thread arrived
	 * in a page load or over the stream, exactly like the card it sits on.
	 *
	 * Two things it deliberately does not do. It does not insert the reply it
	 * just sent: the write publishes `message.created`, the tab hears it on the
	 * stream and refetches (`threads.svelte.ts`), so the message appears the same
	 * way it appears in the tab that was only watching. And it does not hide the
	 * reply control behind a hover — a phone cannot hover (§7), and this is a
	 * primary target rather than a fallback.
	 *
	 * Message bodies are markdown and untrusted like every other body on this
	 * page: they go through {@link Markdown}, whose renderer has raw HTML
	 * disabled (design §8). An agent replying with `<script>` gets a `<script>`
	 * on the screen, not one in the owner's browser.
	 */
	import Ack from './Ack.svelte';
	import Markdown from './Markdown.svelte';
	import { actionMessage } from './actions';
	import { agentLabel } from './avatar';
	import { onMount } from 'svelte';
	import { absoluteLabel, relativeLabel } from './days';
	import { clock } from './clock.svelte';
	import type { AckView, MessageView } from './types';

	let {
		/** The thread, oldest first. Empty is the common case. */
		messages = [],
		/** Post a reply. Resolves when the server has it; rejects with a message. */
		onreply,
		/** Agent id to display name, as the shell resolves it for the cards. */
		agentNames = {},
		/**
		 * What agents have said about each message, by message id (migration 013).
		 *
		 * This is what stops a reply sitting there looking unread: the tick or the
		 * "is thinking…" goes under the line it answers, not somewhere else on the
		 * card.
		 */
		acks = {},
		/** Ids of the agents beating right now, so a stale "thinking" is not shown. */
		onlineIds = []
	}: {
		messages?: MessageView[];
		onreply: (body: string) => Promise<void>;
		agentNames?: Record<string, string>;
		acks?: Record<string, AckView[]>;
		onlineIds?: string[];
	} = $props();

	let open = $state(false);
	/** The box itself, so opening it can put the cursor in it. */
	let box = $state<HTMLTextAreaElement | null>(null);
	let busy = $state(false);
	let error = $state<string | null>(null);
	let draft = $state('');

	/**
	 * Who said it.
	 *
	 * `human` is the owner, and the owner is the one reading this, so it says
	 * "You" rather than repeating a name nobody set. Anything else is
	 * `agent:<agent_id>` (design §3), named from the same map the cards use and
	 * falling back to a short readable id — every ULID starts `01` until 2039, so
	 * printing the raw id would make every agent look like the same one.
	 */
	function speaker(author: string): string {
		if (author === 'human') return 'You';
		const agentId = author.startsWith('agent:') ? author.slice('agent:'.length) : '';
		return agentLabel(agentId, agentNames[agentId]);
	}

	// Opening the box puts the cursor in it: the owner pressed Reply, so they are
	// about to type.
	$effect(() => {
		if (open) box?.focus();
	});

	function close(): void {
		open = false;
		error = null;
		draft = '';
	}

	async function send(): Promise<void> {
		busy = true;
		error = null;
		try {
			await onreply(draft.trim());
			close();
		} catch (cause) {
			// The box stays open holding what was typed: retyping a paragraph to
			// find out the connection dropped is nobody's idea of a good time.
			error = actionMessage(cause);
		} finally {
			busy = false;
		}
	}

	/**
	 * Ctrl/Cmd+Enter sends; plain Enter is a newline.
	 *
	 * A reply is markdown and often several lines, so Enter must not submit — but
	 * a keyboard-driven owner should not have to reach for the mouse either.
	 */
	function onkeydown(event: KeyboardEvent): void {
		if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && draft.trim() !== '') {
			event.preventDefault();
			void send();
		}
	}

	/** The page's one ticking clock, so "4m ago" keeps up (design §7). */
	const ticking = clock();
	onMount(() => ticking.hold());
</script>

<section data-thread class="flex min-w-0 flex-col gap-2" aria-label="Replies">
	{#if messages.length > 0}
		<!--
			Each reply is its own box rather than a run of paragraphs down one shared
			rail (#feedback: "more visual clarity between replies").
			
			The rail was cheap and read badly: two replies of three lines each ran
			together into six lines with a name buried in the middle, and the longer
			a thread got the worse it was. A surface of its own gives every reply a
			top and a bottom, which is what the eye is actually looking for.

			The owner's replies carry an accent rail and the agents' do not — the
			same signal `PostCard` uses for a post they wrote, so "mine" means one
			thing everywhere on the page rather than one thing per component.
		-->
		<ol class="flex min-w-0 flex-col gap-1.5">
			{#each messages as message (message.id)}
				<li
					data-message
					data-mine={message.author === 'human' ? 'true' : undefined}
					class="flex min-w-0 flex-col gap-1 rounded-md border border-border-subtle bg-surface px-2.5 py-1.5 {message.author ===
					'human'
						? 'border-l-2 border-l-accent'
						: ''}"
				>
					<p class="flex flex-wrap items-baseline gap-x-2 text-xs">
						<span data-message-author class="font-medium text-content">
							{speaker(message.author)}
						</span>
						<time
							class="ml-auto text-content-muted"
							datetime={new Date(message.createdAt).toISOString()}
							title={absoluteLabel(message.createdAt)}
						>
							{relativeLabel(message.createdAt, ticking.now)}
						</time>
					</p>
					<Markdown body={message.body} />
					<Ack acks={acks[message.id] ?? []} {agentNames} {onlineIds} />
				</li>
			{/each}
		</ol>
	{/if}

	{#if open}
		<div class="flex min-w-0 flex-col gap-2">
			<label class="flex flex-col gap-1 text-xs text-content-muted">
				Reply to this update
				<!--
					Focused by an effect rather than by `autofocus`: the attribute focuses
					on page load as well, which would steal the cursor from a reader who
					never asked for a reply box.
				-->
				<textarea
					bind:this={box}
					bind:value={draft}
					{onkeydown}
					rows="3"
					placeholder="Markdown. Ctrl+Enter sends."
					class="w-full rounded border border-border-subtle bg-surface px-2 py-1.5 text-sm text-content"
				></textarea>
			</label>

			{#if error}
				<p role="alert" class="text-xs text-rose-400">{error}</p>
			{/if}

			<div class="flex flex-wrap justify-end gap-2">
				<button
					type="button"
					onclick={close}
					class="min-h-11 rounded px-3 text-sm text-content-muted hover:text-content"
				>
					Cancel
				</button>
				<button
					type="button"
					disabled={busy || draft.trim() === ''}
					onclick={send}
					class="min-h-11 rounded bg-accent px-3 text-sm font-medium text-surface disabled:opacity-50"
				>
					Send reply
				</button>
			</div>
		</div>
	{:else}
		<button
			type="button"
			aria-expanded={false}
			onclick={() => (open = true)}
			class="flex min-h-11 w-fit items-center gap-1.5 rounded px-2 text-xs font-medium text-content-muted hover:bg-surface-raised hover:text-content"
		>
			<svg class="size-3" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
				<path d="M2 3h12v8H6l-4 3z" />
			</svg>
			Reply
		</button>
	{/if}
</section>
