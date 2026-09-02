<script lang="ts">
	/**
	 * One request an agent is blocked on, as a card in the feed (design §5, §7).
	 *
	 * **A card, not a banner.** This used to be a sticky bar above the header,
	 * which put the loudest thing on the page permanently in the way of the thing
	 * the page is for. It is now the first section of the timeline: it reads as
	 * part of the feed, it scrolls with the feed, and the sidebar carries a count
	 * so a request in a project you are not looking at is still visible.
	 *
	 * **One card per request, so the queue cannot overwrite itself.** The banner
	 * had to promote one request and reduce the rest to chips; a list of cards has
	 * no such problem, and every blocked agent is answerable where it sits. That
	 * is also why this component holds only *its own* draft: with one card per
	 * request there is nothing to key by id.
	 *
	 * **Each kind renders its own control**, because a "yes/no" that arrives as a
	 * text box is a slower answer and a worse one:
	 *
	 * - `text` — an input, or a textarea when the agent asked for one.
	 * - `confirm` — approve and reject.
	 * - `buttons` — one button per action, wrapping rather than overflowing.
	 * - `choice` — a radio list.
	 * - `multi_choice` — a checkbox list, with min and max enforced before submit.
	 * - `form` — an editable field *and* the agent's own action buttons, answered
	 *   as `{ action, text }`. The generic one: "here is the message I am about to
	 *   send, change it if you like, then approve or reject" is one decision, and
	 *   splitting it into an edit and a confirm means one of the two gets answered
	 *   about text that has already moved.
	 *
	 * The min/max check here is a courtesy to the owner, never the guarantee: the
	 * server validates every answer against the request that asked for it
	 * (`src/domain/requests.ts`), because a browser is not a trustworthy client.
	 *
	 * Mobile is not a fallback (design §7). At 375px the actions wrap, the option
	 * rows are full width, every control is at least 44px tall, and nothing is
	 * revealed by hover — a request has to be answerable on a phone, because that
	 * is where the owner often is when an agent stops.
	 */
	import Avatar from './Avatar.svelte';
	import { agentLabel } from './avatar';
	import { actionMessage, type OwnerActions } from './actions';
	import { expiryLabel } from './days';
	import type { RequestFormValue, RequestView } from './types';

	let {
		request,
		/** What to call the blocked agent. A ULID names nobody; see {@link agentLabel}. */
		agentName,
		/**
		 * Which project this is about, rendered only when the feed is not already
		 * scoped to it — on a project page the name would be on every card, saying
		 * nothing.
		 */
		projectName = null,
		/** Arrived over the stream, so it animates in exactly once. */
		isNew = false,
		actions
	}: {
		request: RequestView;
		agentName?: string;
		projectName?: string | null;
		isNew?: boolean;
		actions: OwnerActions;
	} = $props();

	let busy = $state(false);
	let error = $state<string | null>(null);

	/** This card's draft. `null` means "the agent's default, untouched". */
	let typed = $state<string | null>(null);
	let picked = $state<string | null>(null);
	let ticked = $state<string[]>([]);

	const asker = $derived(agentLabel(request.agentId, agentName));
	const text = $derived(typed ?? request.config?.default ?? '');
	const chosen = $derived(picked ?? request.config?.default ?? '');

	/** What the field is called, on screen and to a screen reader. */
	const fieldLabel = $derived(request.config?.label ?? 'Your answer');

	const minimum = $derived(request.config?.min ?? 0);
	const maximum = $derived(request.config?.max ?? request.options?.length ?? 0);

	// Captured once. A live countdown would re-render the card forever to tell the
	// owner something they only need the order of magnitude of, and a request's
	// expiry never changes: the row is keyed by id in the feed, so a card whose
	// request were replaced would be a different card.
	// svelte-ignore state_referenced_locally
	const expires = expiryLabel(request.expiresAt, Date.now());

	/**
	 * Whether the control as it stands may be submitted.
	 *
	 * Only the count rules, and only for the owner's benefit — a disabled button
	 * that says why beats a refusal after the click. Everything else is the
	 * server's to judge.
	 */
	const ready = $derived.by(() => {
		// A form's field may legitimately be left empty unless the agent said
		// otherwise; a `text` request exists *because* something must be typed.
		if (request.kind === 'form') return text.trim().length >= (request.config?.min ?? 0);
		if (request.kind === 'text') return text.trim().length >= (request.config?.min ?? 1);
		if (request.kind === 'choice') return chosen !== '';
		if (request.kind === 'multi_choice') {
			return ticked.length >= minimum && ticked.length <= maximum;
		}
		return true;
	});

	function toggle(option: string, on: boolean): void {
		ticked = on ? [...ticked, option] : ticked.filter((item) => item !== option);
	}

	/** Answer, then let the stream take this card off the feed. */
	async function answer(value: string | boolean | string[] | RequestFormValue): Promise<void> {
		busy = true;
		error = null;
		try {
			await actions.answerRequest(request.id, value);
		} catch (cause) {
			// What the owner typed stays on screen: a refused answer they have to
			// retype is a worse outcome than the refusal itself.
			error = actionMessage(cause);
		} finally {
			busy = false;
		}
	}

	async function dismiss(): Promise<void> {
		busy = true;
		error = null;
		try {
			await actions.dismissRequest(request.id);
		} catch (cause) {
			error = actionMessage(cause);
		} finally {
			busy = false;
		}
	}

	function submit(): void {
		if (!ready) return;
		if (request.kind === 'text') void answer(text.trim());
		else if (request.kind === 'choice') void answer(chosen);
		else if (request.kind === 'multi_choice') void answer(ticked);
	}

	/** One option row: a full-width target that shows its own selected state. */
	const OPTION_ROW =
		'flex min-h-11 min-w-0 cursor-pointer items-center gap-2.5 rounded-md border border-border-subtle px-3 py-1.5 text-sm text-content transition-colors hover:border-content-muted hover:bg-surface has-checked:border-amber-500 has-checked:bg-amber-500/10';
</script>

<article
	data-testid="request-card"
	data-request-id={request.id}
	data-kind={request.kind}
	aria-label="Request from {asker}"
	class="relative flex gap-3 overflow-hidden rounded-lg border border-amber-500/40 bg-surface-raised py-3 pr-4 pl-5 shadow-sm {isNew
		? 'update-enter'
		: ''}"
>
	<!-- Amber down the left edge, the way a level colour marks an update card. -->
	<span class="absolute inset-y-0 left-0 w-1.5 bg-amber-500" aria-hidden="true"></span>

	<Avatar name={asker} />

	<div class="flex min-w-0 flex-1 flex-col gap-3">
		<header class="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
			<span class="font-medium text-content">{asker}</span>
			<!--
				A solid amber chip with black ink, not a semantic token and not a
				translucent tint. This is the label that says an agent is stopped
				dead, so it has to be legible in both themes without depending on
				what is behind it: the tint version measured 1.05:1 in light mode
				(invisible), and a tint plus a themed ink still only reached 2.57:1
				at 10px bold. This pair is theme-independent and clears AA.
			-->
			<span
				class="rounded bg-amber-500 px-1.5 py-0.5 text-[0.65rem] font-semibold tracking-wide text-black uppercase"
			>
				Waiting on you
			</span>
			{#if projectName}
				<span class="truncate text-xs text-content-muted" data-testid="request-project">
					{projectName}
				</span>
			{/if}
			<span class="ml-auto text-xs text-content-muted tabular-nums" data-testid="request-expiry">
				{expires}
			</span>
		</header>

		<div class="flex min-w-0 flex-col gap-1.5">
			<p class="min-w-0 text-base font-semibold tracking-tight break-words text-content">
				{request.question}
			</p>
			{#if request.detail}
				<p class="min-w-0 text-sm break-words whitespace-pre-wrap text-content-muted">
					{request.detail}
				</p>
			{/if}
		</div>

		{#if request.kind === 'text' || request.kind === 'form'}
			<label class="flex min-w-0 flex-col gap-1">
				<!--
					A form's field is named on screen, because the owner is being asked to
					edit a specific thing — "Message", "Commit message" — and an unlabelled
					box above "Approve" does not say what approving would send.
				-->
				{#if request.config?.label}
					<span class="text-xs font-medium text-content-muted">{request.config.label}</span>
				{:else}
					<span class="sr-only">{fieldLabel}</span>
				{/if}
				{#if request.config?.multiline}
					<textarea
						rows="3"
						aria-label={fieldLabel}
						placeholder={request.config?.placeholder ?? ''}
						maxlength={request.config?.max ?? undefined}
						value={text}
						oninput={(event) => (typed = event.currentTarget.value)}
						class="w-full rounded-md border-border-subtle bg-surface px-3 py-2 text-sm text-content focus:border-amber-500 focus:ring-1 focus:ring-amber-500"
					></textarea>
				{:else}
					<input
						type="text"
						aria-label={fieldLabel}
						placeholder={request.config?.placeholder ?? ''}
						maxlength={request.config?.max ?? undefined}
						value={text}
						oninput={(event) => (typed = event.currentTarget.value)}
						onkeydown={(event) => {
							if (event.key === 'Enter') submit();
						}}
						class="min-h-11 w-full rounded-md border-border-subtle bg-surface px-3 text-sm text-content focus:border-amber-500 focus:ring-1 focus:ring-amber-500"
					/>
				{/if}
			</label>
		{/if}

		{#if request.kind === 'choice'}
			<fieldset class="flex min-w-0 flex-col gap-1.5">
				<legend class="sr-only">Choose one</legend>
				{#each request.options ?? [] as option (option)}
					<label class={OPTION_ROW}>
						<input
							type="radio"
							name="request-{request.id}"
							value={option}
							checked={chosen === option}
							onchange={() => (picked = option)}
							class="size-4 shrink-0 text-amber-500 focus:ring-amber-500"
						/>
						<span class="min-w-0 break-words">{option}</span>
					</label>
				{/each}
			</fieldset>
		{/if}

		{#if request.kind === 'multi_choice'}
			<fieldset class="flex min-w-0 flex-col gap-1.5">
				<legend class="sr-only">Choose any</legend>
				{#each request.options ?? [] as option (option)}
					<label class={OPTION_ROW}>
						<input
							type="checkbox"
							value={option}
							checked={ticked.includes(option)}
							onchange={(event) => toggle(option, event.currentTarget.checked)}
							class="size-4 shrink-0 rounded text-amber-500 focus:ring-amber-500"
						/>
						<span class="min-w-0 break-words">{option}</span>
					</label>
				{/each}
				{#if minimum > 0 || maximum < (request.options?.length ?? 0)}
					<p class="text-xs text-content-muted" data-testid="request-bounds">
						Choose between {minimum} and {maximum}.
					</p>
				{/if}
			</fieldset>
		{/if}

		{#if error}
			<p role="alert" class="text-sm text-rose-400">{error}</p>
		{/if}

		<div class="flex min-w-0 flex-wrap items-center gap-2">
			{#if request.kind === 'confirm'}
				<button
					type="button"
					disabled={busy}
					onclick={() => void answer(true)}
					class="min-h-11 rounded-md bg-emerald-700 px-4 text-sm font-medium text-white transition-colors hover:bg-emerald-600 disabled:opacity-50"
				>
					Approve
				</button>
				<button
					type="button"
					disabled={busy}
					onclick={() => void answer(false)}
					class="min-h-11 rounded-md border border-border-subtle bg-surface px-4 text-sm font-medium text-content transition-colors hover:border-content-muted hover:bg-surface-raised disabled:opacity-50"
				>
					Reject
				</button>
			{:else if request.kind === 'form'}
				<!--
					The agent's own labels, and each one carries the field with it: the
					answer is a single decision — what to do, and what to do it to.
				-->
				{#each request.options ?? [] as option (option)}
					<button
						type="button"
						disabled={busy || !ready}
						onclick={() => void answer({ action: option, text: text.trim() })}
						class="min-h-11 rounded-md border border-border-subtle bg-surface px-4 text-sm font-medium text-content transition-colors hover:border-amber-500 hover:bg-amber-500/10 disabled:opacity-50"
					>
						{option}
					</button>
				{/each}
			{:else if request.kind === 'buttons'}
				{#each request.options ?? [] as option (option)}
					<button
						type="button"
						disabled={busy}
						onclick={() => void answer(option)}
						class="min-h-11 rounded-md border border-border-subtle bg-surface px-4 text-sm font-medium text-content transition-colors hover:border-amber-500 hover:bg-amber-500/10 disabled:opacity-50"
					>
						{option}
					</button>
				{/each}
			{:else}
				<button
					type="button"
					disabled={busy || !ready}
					onclick={submit}
					class="min-h-11 rounded-md bg-emerald-700 px-4 text-sm font-medium text-white transition-colors hover:bg-emerald-600 disabled:opacity-50"
				>
					Send
				</button>
			{/if}

			<button
				type="button"
				disabled={busy}
				onclick={() => void dismiss()}
				class="ml-auto min-h-11 rounded-md px-3 text-xs text-content-muted transition-colors hover:text-content disabled:opacity-50"
			>
				Dismiss
			</button>
		</div>
	</div>
</article>
