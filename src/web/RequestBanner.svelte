<script lang="ts">
	/**
	 * The sticky top banner (design §7).
	 *
	 * **Not a rail item, and that is the whole point.** Every other live region
	 * here reports on work that is happening; this one reports that work has
	 * *stopped* — an agent is sitting waiting on a human, and until the human
	 * answers, nothing it was asked to do is progressing. So it takes the top of
	 * the page, above the header, and it is impossible to miss.
	 *
	 * **The queue never overwrites itself.** Two agents can be blocked at once,
	 * and the second must not replace the first. Every outstanding request is in
	 * the DOM: the one being answered in full, and the rest as a row of chips that
	 * select them. The chips are ordered by the server's `seq`, so the agent that
	 * has waited longest is at the front and answering one promotes the next.
	 *
	 * **Each kind renders its own control**, because a "yes/no" that arrives as a
	 * text box is a slower answer and a worse one:
	 *
	 * - `text` — an input, or a textarea when the agent asked for one.
	 * - `confirm` — approve and reject.
	 * - `buttons` — one button per action, wrapping rather than overflowing.
	 * - `choice` — a radio list.
	 * - `multi_choice` — a checkbox list, with min and max enforced before submit.
	 *
	 * The min/max check here is a courtesy to the owner, never the guarantee: the
	 * server validates every answer against the request that asked for it
	 * (`src/domain/requests.ts`), because a browser is not a trustworthy client.
	 *
	 * Mobile is not a fallback (design §7). At 375px the chips wrap, the option
	 * lists are full width, every control is at least 44px tall, and nothing is
	 * revealed by hover — a request has to be answerable on a phone, because that
	 * is where the owner often is when an agent stops.
	 */
	import { actionMessage, type OwnerActions } from './actions';
	import { Requests } from './requests.svelte';
	import type { RequestView } from './types';

	let {
		/** The live queue. Owned by whoever mounts this; a spec injects its own. */
		requests = new Requests(),
		/** Agent id to display name, from the shell. A ULID names nobody. */
		agentNames = {},
		actions
	}: {
		requests?: Requests;
		agentNames?: Record<string, string>;
		actions: OwnerActions;
	} = $props();

	/** Which request the owner is answering. Null means "the front of the queue". */
	let selected = $state<string | null>(null);
	let busy = $state(false);
	let error = $state<string | null>(null);

	/** What the text box holds, and which checkboxes are ticked, per request. */
	let typed = $state<Record<string, string>>({});
	let ticked = $state<Record<string, string[]>>({});
	let picked = $state<Record<string, string>>({});

	const queue = $derived(requests.items);
	const active = $derived(queue.find((request) => request.id === selected) ?? queue[0] ?? null);
	const others = $derived(queue.filter((request) => request.id !== active?.id));

	/** The default the agent supplied, until the owner types over it. */
	const text = $derived(active === null ? '' : (typed[active.id] ?? active.config?.default ?? ''));
	const chosen = $derived(
		active === null ? '' : (picked[active.id] ?? active.config?.default ?? '')
	);
	const checked = $derived(active === null ? [] : (ticked[active.id] ?? []));

	const minimum = $derived(active?.config?.min ?? 0);
	const maximum = $derived(active?.config?.max ?? active?.options?.length ?? 0);

	/**
	 * Whether the control as it stands may be submitted.
	 *
	 * Only the count rules, and only for the owner's benefit — a disabled button
	 * that says why beats a refusal after the click. Everything else is the
	 * server's to judge.
	 */
	const ready = $derived.by(() => {
		if (active === null) return false;
		if (active.kind === 'text') return text.trim().length >= (active.config?.min ?? 1);
		if (active.kind === 'choice') return chosen !== '';
		if (active.kind === 'multi_choice') {
			return checked.length >= minimum && checked.length <= maximum;
		}
		return true;
	});

	function nameFor(agentId: string): string {
		return agentNames[agentId] ?? agentId;
	}

	function toggle(option: string, on: boolean): void {
		if (active === null) return;
		const next = on ? [...checked, option] : checked.filter((item) => item !== option);
		ticked = { ...ticked, [active.id]: next };
	}

	/** Answer, then let the stream bring the queue back without this request in it. */
	async function answer(request: RequestView, value: string | boolean | string[]): Promise<void> {
		busy = true;
		error = null;
		try {
			await actions.answerRequest(request.id, value);
			forget(request.id);
		} catch (cause) {
			// What the owner typed stays on screen: a refused answer they have to
			// retype is a worse outcome than the refusal itself.
			error = actionMessage(cause);
		} finally {
			busy = false;
		}
	}

	async function dismiss(request: RequestView): Promise<void> {
		busy = true;
		error = null;
		try {
			await actions.dismissRequest(request.id);
			forget(request.id);
		} catch (cause) {
			error = actionMessage(cause);
		} finally {
			busy = false;
		}
	}

	/**
	 * Drop the local draft, and fall back to the front of the queue.
	 *
	 * The drafts are keyed by request id and dropped one at a time rather than
	 * cleared wholesale: another request in the queue may be half-answered, and
	 * answering this one must not throw that away.
	 */
	function forget(id: string): void {
		selected = null;
		typed = without(typed, id);
		picked = without(picked, id);
		ticked = without(ticked, id);
	}

	function without<T>(drafts: Record<string, T>, id: string): Record<string, T> {
		return Object.fromEntries(Object.entries(drafts).filter(([key]) => key !== id));
	}

	function submit(): void {
		if (active === null || !ready) return;
		if (active.kind === 'text') void answer(active, text.trim());
		else if (active.kind === 'choice') void answer(active, chosen);
		else if (active.kind === 'multi_choice') void answer(active, checked);
	}
</script>

{#if active}
	<!--
		`sticky top-0` inside the page's own scroll container, and a z-index above
		the drawers: a request must stay on screen while the owner scrolls the
		timeline looking for the context to answer it with.
	-->
	<section
		data-testid="request-banner"
		aria-label="Requests waiting on you"
		class="sticky top-0 z-50 border-b border-amber-500/40 bg-amber-500/10 backdrop-blur"
	>
		<div class="flex min-w-0 flex-col gap-2 px-3 py-2 sm:px-4">
			<div class="flex min-w-0 flex-wrap items-center gap-2">
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
				<span class="text-xs text-content-muted">
					{nameFor(active.agentId)} is blocked
				</span>
				{#if queue.length > 1}
					<span class="text-xs text-content-muted tabular-nums" data-testid="request-count">
						{queue.length} requests waiting
					</span>
				{/if}
			</div>

			<p class="min-w-0 text-sm font-medium break-words text-content">{active.question}</p>
			{#if active.detail}
				<p class="min-w-0 text-xs break-words whitespace-pre-wrap text-content-muted">
					{active.detail}
				</p>
			{/if}

			{#if active.kind === 'text'}
				<label class="flex min-w-0 flex-col gap-1 text-xs text-content-muted">
					<span class="sr-only">Your answer</span>
					{#if active.config?.multiline}
						<textarea
							rows="3"
							aria-label="Your answer"
							placeholder={active.config?.placeholder ?? ''}
							maxlength={active.config?.max ?? undefined}
							value={text}
							oninput={(event) => (typed = { ...typed, [active.id]: event.currentTarget.value })}
							class="w-full rounded border border-border-subtle bg-surface px-2 py-1 text-sm text-content"
						></textarea>
					{:else}
						<input
							type="text"
							aria-label="Your answer"
							placeholder={active.config?.placeholder ?? ''}
							maxlength={active.config?.max ?? undefined}
							value={text}
							oninput={(event) => (typed = { ...typed, [active.id]: event.currentTarget.value })}
							onkeydown={(event) => {
								if (event.key === 'Enter') submit();
							}}
							class="min-h-11 w-full rounded border border-border-subtle bg-surface px-2 text-sm text-content"
						/>
					{/if}
				</label>
			{/if}

			{#if active.kind === 'choice'}
				<fieldset class="flex min-w-0 flex-col gap-1">
					<legend class="sr-only">Choose one</legend>
					{#each active.options ?? [] as option (option)}
						<label class="flex min-h-11 min-w-0 items-center gap-2 text-sm text-content">
							<input
								type="radio"
								name="request-{active.id}"
								value={option}
								checked={chosen === option}
								onchange={() => (picked = { ...picked, [active.id]: option })}
								class="size-4 shrink-0"
							/>
							<span class="min-w-0 break-words">{option}</span>
						</label>
					{/each}
				</fieldset>
			{/if}

			{#if active.kind === 'multi_choice'}
				<fieldset class="flex min-w-0 flex-col gap-1">
					<legend class="sr-only">Choose any</legend>
					{#each active.options ?? [] as option (option)}
						<label class="flex min-h-11 min-w-0 items-center gap-2 text-sm text-content">
							<input
								type="checkbox"
								value={option}
								checked={checked.includes(option)}
								onchange={(event) => toggle(option, event.currentTarget.checked)}
								class="size-4 shrink-0"
							/>
							<span class="min-w-0 break-words">{option}</span>
						</label>
					{/each}
					{#if minimum > 0 || maximum < (active.options?.length ?? 0)}
						<p class="text-xs text-content-muted" data-testid="request-bounds">
							Choose between {minimum} and {maximum}.
						</p>
					{/if}
				</fieldset>
			{/if}

			{#if error}
				<p role="alert" class="text-xs text-rose-400">{error}</p>
			{/if}

			<div class="flex min-w-0 flex-wrap items-center gap-2">
				{#if active.kind === 'confirm'}
					<button
						type="button"
						disabled={busy}
						onclick={() => void answer(active, true)}
						class="min-h-11 rounded bg-emerald-700 px-3 text-sm font-medium text-white disabled:opacity-50"
					>
						Approve
					</button>
					<button
						type="button"
						disabled={busy}
						onclick={() => void answer(active, false)}
						class="min-h-11 rounded border border-border-subtle px-3 text-sm text-content disabled:opacity-50"
					>
						Reject
					</button>
				{:else if active.kind === 'buttons'}
					{#each active.options ?? [] as option (option)}
						<button
							type="button"
							disabled={busy}
							onclick={() => void answer(active, option)}
							class="min-h-11 rounded border border-border-subtle bg-surface px-3 text-sm text-content disabled:opacity-50"
						>
							{option}
						</button>
					{/each}
				{:else}
					<button
						type="button"
						disabled={busy || !ready}
						onclick={submit}
						class="min-h-11 rounded bg-emerald-700 px-3 text-sm font-medium text-white disabled:opacity-50"
					>
						Send
					</button>
				{/if}

				<button
					type="button"
					disabled={busy}
					onclick={() => void dismiss(active)}
					class="ml-auto min-h-11 rounded px-3 text-xs text-content-muted hover:text-content disabled:opacity-50"
				>
					Dismiss
				</button>
			</div>

			{#if others.length > 0}
				<!--
					The rest of the queue. Every outstanding request is here, so none can
					be lost behind the one on screen (design §7).
				-->
				<div class="flex min-w-0 flex-wrap items-center gap-2 border-t border-amber-500/20 pt-2">
					<span class="text-[0.65rem] tracking-wide text-content-muted uppercase">Also waiting</span
					>
					{#each others as request (request.id)}
						<button
							type="button"
							onclick={() => (selected = request.id)}
							class="min-h-11 max-w-full truncate rounded border border-border-subtle bg-surface px-2 text-xs text-content-muted hover:text-content"
						>
							{nameFor(request.agentId)}: {request.question}
						</button>
					{/each}
				</div>
			{/if}
		</div>
	</section>
{/if}
