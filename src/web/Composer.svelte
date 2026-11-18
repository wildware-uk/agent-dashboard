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
	import Attachments from './Attachments.svelte';
	import Spinner from './Spinner.svelte';
	import TagPicker from './TagPicker.svelte';
	import { actionMessage, type OwnerActions } from './actions';
	import { tagLook, tagsFor } from './tags';
	import { Uploads } from './uploads.svelte';
	import type { ProjectView, TagView } from './types';

	let {
		/** The project on screen, or `null` on the all-projects view. */
		project = null,
		/** Every project, for the picker the all-projects view needs. */
		projects = [],
		/** Every word the projects on this page know (migration 039). */
		tags = [],
		actions
	}: {
		project?: string | null;
		projects?: ProjectView[];
		tags?: TagView[];
		actions: OwnerActions;
	} = $props();

	let text = $state('');
	let target = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);
	let box = $state<HTMLTextAreaElement | null>(null);
	/**
	 * Images going out with this post (migration 016).
	 *
	 * Built from the actions once, deliberately: this component is mounted with
	 * one server behind it for its whole life, and rebuilding the queue if that
	 * prop changed would throw away pictures mid-upload.
	 */
	// svelte-ignore state_referenced_locally
	const uploads = new Uploads(actions);
	/** True while a file is being dragged over the box, so it can say it will take it. */
	let dragging = $state(false);

	/**
	 * The words this post will wear, chosen before it exists (migration 039).
	 *
	 * The owner: "let me set tags on a post before I actually post it." A draft
	 * has no id, so nothing can be written yet — the ids are held here and
	 * applied the moment the post comes back with one. If the post lands and a
	 * tag does not, the post still stands: a label is worth less than the words.
	 */
	let picked = $state<string[]>([]);
	let picking = $state(false);
	/** The button that opens the picker, so pressing it again closes it. */
	let tagTrigger = $state<HTMLElement | null>(null);

	/** Where it goes: the project on screen, or the one picked. */
	const destination = $derived(project ?? target);
	/** Which project's words to offer: the one this post is going to. */
	const project_ = $derived(projects.find((candidate) => candidate.slug === destination) ?? null);
	const available = $derived(tagsFor(project_?.id, tags));
	const chosen = $derived(new Set(picked));
	const wearing = $derived(available.filter((tag) => chosen.has(tag.id)));
	// A picture on its own is a post: "look at this" needs no words. What it must
	// not do is post while an upload is still in flight, or the ids would be short
	// by however many had not landed.
	const ready = $derived(
		(text.trim() !== '' || uploads.ids.length > 0) && destination !== '' && !busy && !uploads.busy
	);

	async function send(): Promise<void> {
		const body = text.trim();
		const mediaIds = uploads.ids;
		if ((body === '' && mediaIds.length === 0) || destination === '') return;

		busy = true;
		error = null;
		try {
			const posted = await actions.postMessage({
				project: destination,
				body,
				...(mediaIds.length > 0 ? { mediaIds } : {})
			});
			// The tags the owner chose before there was anything to put them on.
			// One call each, after the fact: the post is the thing that matters, and
			// a label that failed to land is not worth failing the post for.
			for (const tagId of picked) {
				await actions.tagCard('message', posted.id, tagId, true).catch(() => {});
			}
			text = '';
			picked = [];
			uploads.clear();
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
	 * Cmd+Enter or Ctrl+Enter sends; plain Enter is a newline.
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

	/**
	 * A pasted or dropped image becomes an attachment.
	 *
	 * Wired on the box rather than on the document: a paste belongs to whatever
	 * is focused, and a component grabbing it globally would swallow one meant
	 * for something else on the page. The event is only prevented when there
	 * really are files on it, so pasting text still pastes text.
	 */
	function onpaste(event: ClipboardEvent): void {
		const files = [...(event.clipboardData?.files ?? [])];
		if (files.length === 0) return;
		event.preventDefault();
		void uploads.add(files);
	}

	function ondrop(event: DragEvent): void {
		dragging = false;
		const files = [...(event.dataTransfer?.files ?? [])];
		if (files.length === 0) return;
		event.preventDefault();
		void uploads.add(files);
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
				{onpaste}
				{ondrop}
				ondragover={(event) => {
					// Preventing this is what tells the browser a drop is welcome here;
					// without it the page navigates to the file instead.
					event.preventDefault();
					dragging = true;
				}}
				ondragleave={() => (dragging = false)}
				rows="2"
				placeholder="Say something to your agents. Markdown, images, Cmd/Ctrl+Enter posts."
				class="w-full min-w-0 rounded border bg-surface px-2 py-1.5 text-sm text-content {dragging
					? 'border-accent'
					: 'border-border-subtle'}"></textarea>
		</label>

		<button
			type="button"
			disabled={!ready}
			onclick={send}
			class="flex min-h-11 shrink-0 items-center gap-1.5 rounded bg-accent px-3 text-xs font-medium text-surface disabled:opacity-50"
		>
			<!-- What is happening, not just that the button is dead (design §7). -->
			{#if busy}<Spinner size="0.75rem" />{/if}
			{busy ? 'Posting' : 'Post'}
		</button>
	</div>

	<!--
		The words this post will wear (migration 039). The owner: "let me set tags
		on a post before I actually post it." Beside the attachments, because both
		are things going out with the post rather than things about the box.
	-->
	<div class="flex flex-wrap items-center gap-1" data-testid="composer-tags">
		{#each wearing as tag (tag.id)}
			<button
				type="button"
				data-tag={tag.id}
				aria-label="Remove the tag {tag.name}"
				onclick={() => (picked = picked.filter((id) => id !== tag.id))}
				class="rounded-full border px-2 py-0.5 text-[0.7rem] font-medium {tagLook(tag.colour)}"
			>
				{tag.name}
			</button>
		{/each}

		{#if destination !== ''}
			<div class="relative">
				<button
					bind:this={tagTrigger}
					type="button"
					aria-expanded={picking}
					aria-label="Add a tag"
					data-testid="tag-add"
					onclick={() => (picking = !picking)}
					class="flex size-5 items-center justify-center rounded border border-border-subtle text-xs leading-none text-content-muted hover:border-accent hover:text-content"
				>
					<span aria-hidden="true">+</span>
				</button>

				{#if picking}
					<TagPicker
						tags={available}
						{chosen}
						ontoggle={(tagId, on) => {
							picked = on ? [...picked, tagId] : picked.filter((id) => id !== tagId);
						}}
						oncreate={async (name, colour) => {
							// A word invented while writing: it is decided for the project
							// straight away, and held for this post like any other.
							const made = await actions.defineTag(destination, name, colour);
							if (!picked.includes(made.id)) picked = [...picked, made.id];
						}}
						onrecolour={async (tagId, colour) => {
							await actions.renameTag(tagId, { colour });
						}}
						trigger={tagTrigger}
						onclose={() => (picking = false)}
					/>
				{/if}
			</div>
		{/if}
	</div>

	<Attachments {uploads} label="Add file" />

	{#if error}
		<p role="alert" class="text-xs text-rose-400">{error}</p>
	{:else}
		<p class="text-xs text-content-muted">
			Goes on the feed as you, and every agent working this project hears it. They decide whether it
			needs a task, an answer, or a question back.
		</p>
	{/if}
</section>
