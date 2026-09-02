<script lang="ts">
	/**
	 * The box at the top of the feed: the owner says something (design §7).
	 *
	 * What it posts is a **message**, and that is the whole design. It first
	 * created a task, which was wrong in the way that only shows up in use: it
	 * made the owner do the triage. Deciding whether a sentence deserves a task,
	 * what its title should be and who it is for is the agent's job — the owner
	 * types the sentence.
	 *
	 * So the post lands on the feed as a card authored by them, every agent
	 * working the project hears it through the channel with the text attached, and
	 * what happens next is the agent's call: `create_task` if it is work, a reply
	 * if it is a question, a question back if it is unclear.
	 *
	 * A message rather than an update because `updates.agent_id` is `NOT NULL` and
	 * this codebase does not rebuild live tables to add a nullable column. That
	 * turned out to be the better fit anyway: messages already raise
	 * `unread_messages`, the channel already pushes their text into a running
	 * session, and `get_messages` already delivers them — so an owner post needed
	 * no new notification path at all.
	 */
	import { actionMessage, type OwnerActions } from './actions';
	import type { ProjectView } from './types';

	let {
		/** The project on screen, or `null` on the all-projects view. */
		project = null,
		/** Every project, for the picker the all-projects view needs. */
		projects = [],
		actions
	}: {
		project?: string | null;
		projects?: ProjectView[];
		actions: OwnerActions;
	} = $props();

	let text = $state('');
	let target = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);
	let box = $state<HTMLTextAreaElement | null>(null);

	/** Where it goes: the project on screen, or the one picked. */
	const destination = $derived(project ?? target);
	const ready = $derived(text.trim() !== '' && destination !== '' && !busy);

	async function send(): Promise<void> {
		const body = text.trim();
		if (body === '' || destination === '') return;

		busy = true;
		error = null;
		try {
			await actions.postMessage({ project: destination, body });
			text = '';
			// The card arrives the way every other card does: the write publishes
			// `message.created`, the tab hears it and refetches. Nothing is inserted
			// optimistically here, so the tab that posted and the tab that watched
			// cannot disagree.
			box?.focus();
		} catch (cause) {
			// The box keeps what was typed. Retyping a paragraph to find out the
			// server was down is nobody's idea of a good time.
			error = actionMessage(cause);
		} finally {
			busy = false;
		}
	}

	/**
	 * Ctrl/Cmd+Enter sends; plain Enter is a newline.
	 *
	 * The same way round as the reply box, and for the same reason: this is
	 * markdown that often runs to a paragraph, and Enter submitting would cut
	 * people off mid-thought.
	 */
	function onkeydown(event: KeyboardEvent): void {
		if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && ready) {
			event.preventDefault();
			void send();
		}
	}
</script>

<section
	data-composer
	aria-label="Post to the feed"
	class="flex flex-col gap-2 rounded border border-border-subtle bg-surface-raised p-2"
>
	<div class="flex flex-wrap items-start gap-2">
		{#if project === null}
			<!--
				Only on the all-projects view. With one project on screen the answer is
				already known, and a select offering it back would be a question with
				one answer.
			-->
			<label class="flex min-w-0 flex-col gap-1 text-xs text-content-muted">
				<span class="sr-only">Project</span>
				<select
					bind:value={target}
					aria-label="Project to post in"
					class="min-h-11 rounded border border-border-subtle bg-surface px-2 text-sm text-content"
				>
					<option value="">Choose a project</option>
					{#each projects as candidate (candidate.id)}
						<option value={candidate.slug}>{candidate.name}</option>
					{/each}
				</select>
			</label>
		{/if}

		<label class="flex min-w-0 flex-1 flex-col gap-1">
			<span class="sr-only">What to say</span>
			<textarea
				bind:this={box}
				bind:value={text}
				{onkeydown}
				rows="2"
				placeholder="Say something to your agents. Markdown. Ctrl+Enter posts."
				class="w-full min-w-0 rounded border border-border-subtle bg-surface px-2 py-1.5 text-sm text-content"
			></textarea>
		</label>

		<button
			type="button"
			disabled={!ready}
			onclick={send}
			class="min-h-11 shrink-0 rounded bg-accent px-3 text-xs font-medium text-surface disabled:opacity-50"
		>
			Post
		</button>
	</div>

	{#if error}
		<p role="alert" class="text-xs text-rose-400">{error}</p>
	{:else}
		<p class="text-xs text-content-muted">
			Goes on the feed as you, and every agent working this project hears it. They decide whether it
			needs a task, an answer, or a question back.
		</p>
	{/if}
</section>
