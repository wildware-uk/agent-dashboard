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
	import Attachments from './Attachments.svelte';
	import Markdown from './Markdown.svelte';
	import MediaGrid from './MediaGrid.svelte';
	import { actionMessage } from './actions';
	import { agentLabel } from './avatar';
	import { onMount } from 'svelte';
	import { absoluteLabel, relativeLabel } from './days';
	import { clock } from './clock.svelte';
	import type { AckView, DeliveryView, MediaView, MessageView } from './types';
	import type { OwnerActions } from './actions';
	import { Uploads } from './uploads.svelte';

	let {
		/** The thread, oldest first. Empty is the common case. */
		messages = [],
		/**
		 * Post a reply. Resolves when the server has it; rejects with a message.
		 *
		 * `answers` is the comment being replied to, when the owner picked one:
		 * the reply still lands in this thread, labelled as answering that line
		 * (migration 020).
		 */
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
		onlineIds = [],
		/** The images on each message, by message id (migration 016). */
		media = {},
		/**
		 * Which agents each message has reached, by message id (migration 018).
		 *
		 * What fills the gap under a line nobody has answered: "delivered to
		 * scout" is a different situation from silence, and the owner could not
		 * tell them apart.
		 */
		deliveries = {},
		/**
		 * Somewhere to upload an image for a reply. Given one, the box grows a
		 * picker; without one it is exactly the text box it always was, which is
		 * what keeps every existing spec renderable with no server behind it.
		 */
		uploader = undefined,
		/**
		 * Delete one line of the thread (migration 017).
		 *
		 * Optional, and absent is the shape every spec renders: a thread with
		 * nobody to write as has nothing to delete with either. Given one, each
		 * message grows a control that asks before it fires — deleting a post
		 * takes its replies with it, and there is no undo.
		 */
		ondelete = undefined
	}: {
		messages?: MessageView[];
		onreply: (body: string, mediaIds?: string[], answers?: string) => Promise<void>;
		agentNames?: Record<string, string>;
		acks?: Record<string, AckView[]>;
		onlineIds?: string[];
		media?: Record<string, MediaView[]>;
		deliveries?: Record<string, DeliveryView[]>;
		uploader?: Pick<OwnerActions, 'uploadMedia'>;
		ondelete?: (id: string) => Promise<void>;
	} = $props();

	/**
	 * Which message is asking "are you sure", and what went wrong if it did.
	 *
	 * One id rather than a flag per row: two open confirmations would be two
	 * questions on screen with one answer between them, and an inline dialog
	 * rather than `window.confirm`, which is untestable, unstyleable, and blocks
	 * the tab including the stream — the same call `UpdateActions` makes.
	 */
	let confirming = $state<string | null>(null);
	let deleting = $state<string | null>(null);
	let deleteError = $state<string | null>(null);

	/**
	 * Which comment the box is answering, if any (migration 020).
	 *
	 * The thread stays one flat list — a tree of replies is unreadable on a
	 * phone, which is the whole reason this is a label rather than nesting — and
	 * the box says who it is addressed to while it is open.
	 */
	let answering = $state<string | null>(null);

	let open = $state(false);
	/** The box itself, so opening it can put the cursor in it. */
	let box = $state<HTMLTextAreaElement | null>(null);
	let busy = $state(false);
	let error = $state<string | null>(null);
	let draft = $state('');
	let dragging = $state(false);

	/**
	 * This box's own upload queue (migration 016).
	 *
	 * Built here rather than handed in, because a thread *is* the unit: one per
	 * card, per task, per post. Two drafts open at once are two queues, and a
	 * shared one would put the screenshot on whichever posted first.
	 */
	// svelte-ignore state_referenced_locally
	const uploads = uploader ? new Uploads(uploader) : undefined;

	/**
	 * A picture on its own is a reply — "look at this" needs no words — but
	 * nothing sends while an upload is still in flight, or the ids would be short
	 * by however many had not landed.
	 */
	const ready = $derived(
		(draft.trim() !== '' || (uploads?.ids.length ?? 0) > 0) && !busy && !uploads?.busy
	);

	/**
	 * A pasted or dropped image becomes an attachment.
	 *
	 * On the box rather than on the document: a paste belongs to whatever is
	 * focused, and grabbing it globally would swallow one meant for something
	 * else. Only prevented when there really are files, so pasting text still
	 * pastes text.
	 */
	function onpaste(event: ClipboardEvent): void {
		const files = [...(event.clipboardData?.files ?? [])];
		if (files.length === 0 || !uploads) return;
		event.preventDefault();
		void uploads.add(files);
	}

	function ondrop(event: DragEvent): void {
		dragging = false;
		const files = [...(event.dataTransfer?.files ?? [])];
		if (files.length === 0 || !uploads) return;
		event.preventDefault();
		void uploads.add(files);
	}

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
		answering = null;
	}

	/** Open the box addressed to one comment. */
	function replyTo(messageId: string): void {
		answering = messageId;
		open = true;
		error = null;
	}

	/** The line being answered, for the label above the box. */
	const answered = $derived(messages.find((message) => message.id === answering));

	/** Who wrote the comment with this id, for an "answering …" label. */
	function speakerOf(messageId: string | null | undefined): string | null {
		if (!messageId) return null;
		const found = messages.find((message) => message.id === messageId);
		return found ? speaker(found.author) : null;
	}

	async function remove(id: string): Promise<void> {
		if (!ondelete) return;
		deleting = id;
		deleteError = null;
		try {
			await ondelete(id);
			confirming = null;
		} catch (cause) {
			// The line stays exactly where it was: a failed delete that looked like a
			// successful one is the worst outcome available here.
			deleteError = actionMessage(cause);
		} finally {
			deleting = null;
		}
	}

	async function send(): Promise<void> {
		busy = true;
		error = null;
		try {
			await onreply(draft.trim(), uploads?.ids ?? [], answering ?? undefined);
			uploads?.clear();
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
	 * Cmd+Enter or Ctrl+Enter sends; plain Enter is a newline.
	 *
	 * Both, always: the same person uses a Mac and a Linux box, and a control
	 * that works on one of their machines is a control they stop trusting.
	 *
	 * A reply is markdown and often several lines, so Enter must not submit — but
	 * a keyboard-driven owner should not have to reach for the mouse either.
	 */
	function onkeydown(event: KeyboardEvent): void {
		if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && ready) {
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
						{#if speakerOf(message.answers)}
							<!--
								Who this line was addressed to. A label, not an indent: the
								thread stays one readable list however many conversations are
								running through it.
							-->
							<span data-answering class="text-content-muted">
								answering {speakerOf(message.answers)}
							</span>
						{/if}
						<time
							class="ml-auto text-content-muted"
							datetime={new Date(message.createdAt).toISOString()}
							title={absoluteLabel(message.createdAt)}
						>
							{relativeLabel(message.createdAt, ticking.now)}
						</time>
					</p>
					<Markdown body={message.body} />
					{#if (media[message.id] ?? []).length > 0}
						<MediaGrid items={media[message.id]} />
					{/if}
					<Ack
						acks={acks[message.id] ?? []}
						deliveries={deliveries[message.id] ?? []}
						{agentNames}
						{onlineIds}
					/>

					<div class="flex flex-wrap items-center gap-1">
						<button
							type="button"
							aria-label="Reply to {speaker(message.author)}"
							onclick={() => replyTo(message.id)}
							class="w-fit rounded px-1 py-0.5 text-xs text-content-muted hover:bg-surface-raised hover:text-content"
						>
							Reply
						</button>
					</div>

					{#if ondelete}
						{#if confirming === message.id}
							<div
								role="group"
								aria-label="Confirm delete"
								class="flex flex-wrap items-center gap-2 text-xs"
							>
								<span class="text-content">Delete this message?</span>
								<button
									type="button"
									disabled={deleting !== null}
									onclick={() => remove(message.id)}
									class="rounded bg-rose-600 px-2 py-0.5 font-medium text-white disabled:opacity-50"
								>
									Confirm delete
								</button>
								<button
									type="button"
									disabled={deleting !== null}
									onclick={() => {
										confirming = null;
										deleteError = null;
									}}
									class="rounded border border-border-subtle px-2 py-0.5 text-content-muted hover:text-content"
								>
									Cancel
								</button>
							</div>
							{#if deleteError}
								<p role="alert" class="text-xs text-rose-400">{deleteError}</p>
							{/if}
						{:else}
							<!--
								Always on the row, never behind a hover: a phone cannot hover
								(design §7), and this is the control the owner asked for.
							-->
							<button
								type="button"
								aria-label="Delete this message"
								onclick={() => {
									confirming = message.id;
									deleteError = null;
								}}
								class="w-fit rounded px-1 py-0.5 text-xs text-content-muted hover:bg-surface-raised hover:text-rose-400"
							>
								Delete
							</button>
						{/if}
					{/if}
				</li>
			{/each}
		</ol>
	{/if}

	{#if open}
		<div class="flex min-w-0 flex-col gap-2">
			<label class="flex flex-col gap-1 text-xs text-content-muted">
				{#if answered}
					Answering {speaker(answered.author)}
				{:else}
					Reply to this update
				{/if}
				<!--
					Focused by an effect rather than by `autofocus`: the attribute focuses
					on page load as well, which would steal the cursor from a reader who
					never asked for a reply box.
				-->
				<textarea
					bind:this={box}
					bind:value={draft}
					{onkeydown}
					{onpaste}
					{ondrop}
					ondragover={(event) => {
						if (!uploads) return;
						// Preventing this is what tells the browser a drop is welcome;
						// without it the page navigates to the file instead.
						event.preventDefault();
						dragging = true;
					}}
					ondragleave={() => (dragging = false)}
					rows="3"
					placeholder={uploads
						? 'Markdown, images, Cmd/Ctrl+Enter sends.'
						: 'Markdown. Cmd/Ctrl+Enter sends.'}
					class="w-full rounded border bg-surface px-2 py-1.5 text-sm text-content {dragging
						? 'border-accent'
						: 'border-border-subtle'}"></textarea>
			</label>

			{#if uploads}
				<Attachments {uploads} label="Add image" />
			{/if}

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
					disabled={!ready}
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
