/**
 * The chrome around a fenced code block: what language it is, and a way to take
 * it (design §7).
 *
 * The owner: "for code blocks, I want a small header which says which language
 * it is, as well as a copy button top right."
 *
 * Both halves answer the same question, which is what somebody actually does
 * with code on a dashboard: they read it to find out what it is, and then they
 * want it in their editor. The label settles the first without them having to
 * infer it from the syntax, and the button settles the second without a
 * three-way drag across a scrolling feed.
 *
 * ## It is built here, not in the markdown
 *
 * `renderMarkdown` escapes every raw tag rather than sanitising (`./markdown.ts`),
 * and the value of that is how little it does: markdown in, escaped HTML out.
 * Putting a button in its output would mean the renderer emitting markup that is
 * *not* a translation of what an agent wrote, which is exactly the kind of
 * exception that erodes a rule like that.
 *
 * So the chrome is built from DOM nodes after the fact — `createElement` and
 * `textContent`, never a string of HTML — and it wraps the block the same way
 * whether the block came from an agent's markdown or from an embed's `code`
 * block. One decoration, both callers, no second path to keep in step.
 */

/** What the label says when nothing knows the language. */
export const UNKNOWN_LABEL = 'Code';

/** How long the button says it worked before going back to offering. */
export const COPIED_FOR_MS = 1_400;

/**
 * The name to show for a block: what the author declared, or nothing.
 *
 * `display` is highlight.js's own name for a grammar — "TypeScript" rather than
 * `ts` — because that is what a person calls it. A declared language we have no
 * grammar for is shown as typed: an agent that wrote ```` ```pseudocode ````
 * meant something by it, and replacing that with "Code" would throw away the
 * only thing anybody knew.
 *
 * **A guess is never named**, even though the block is still coloured by one.
 * The two are different acts: colouring on a wrong guess costs a few oddly
 * tinted words, while a header is a *statement*, and a wrong one is worse than
 * none. That is not hypothetical — the first thing this header did on the real
 * dashboard was label a tool signature "Packet Filter config" and an XML tag
 * "PostgreSQL", because highlight.js scores confidence against grammars rather
 * than against the possibility that the fence holds no code at all. Both were
 * bare fences, and "Code" is the true answer for a bare fence: nobody said.
 *
 * The cost is that an unlabelled Kotlin block reads "Code" rather than "Kotlin",
 * and the fix for that belongs with whoever wrote the fence — which is why the
 * skill tells agents to name the language on it.
 */
export function labelFor(
	declared: string | null,
	display: (name: string) => string | undefined
): string {
	if (!declared) return UNKNOWN_LABEL;
	return display(declared) ?? declared;
}

/**
 * Put the text on the clipboard.
 *
 * The modern call needs a secure context, and a dashboard reached over plain
 * HTTP on a LAN is not one — so there is a fallback through a throwaway
 * textarea, which is the old way and still works there. `false` when neither
 * lands, so the button can say nothing rather than claim success.
 */
export async function copyText(text: string): Promise<boolean> {
	try {
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch {
		// Denied, or not a secure context. Fall through and try the old way.
	}

	try {
		const scratch = document.createElement('textarea');
		scratch.value = text;
		// Out of the flow and unfocusable by tab, but still selectable, which is
		// what `execCommand` needs.
		scratch.setAttribute('readonly', '');
		scratch.style.position = 'fixed';
		scratch.style.opacity = '0';
		scratch.style.pointerEvents = 'none';
		document.body.append(scratch);
		scratch.select();
		const copied = document.execCommand('copy');
		scratch.remove();
		return copied;
	} catch {
		return false;
	}
}

/**
 * Wrap one `<pre>` in a header and a copy button.
 *
 * Idempotent: a card re-rendering must not stack a second header on a block that
 * already has one, and the marker is on the wrapper rather than in a set so that
 * a node removed from the page takes its bookkeeping with it.
 *
 * @returns the wrapper, or `null` when the block was already decorated.
 */
export function decorateBlock(pre: HTMLElement, label: string): HTMLElement | null {
	const parent = pre.parentElement;
	if (!parent || parent.dataset.codeBlock === 'yes') return null;

	const wrapper = document.createElement('div');
	wrapper.dataset.codeBlock = 'yes';
	wrapper.className = 'code-block';

	const header = document.createElement('div');
	header.className = 'code-block-header';

	const name = document.createElement('span');
	name.className = 'code-block-language';
	// `textContent`, so a language an agent named is a string on the page and
	// could never be anything else.
	name.textContent = label;

	const button = document.createElement('button');
	button.type = 'button';
	button.className = 'code-block-copy';
	button.textContent = 'Copy';
	// The label carries the language so a screen reader hears which block this
	// belongs to — several on one card otherwise offer the same word.
	button.setAttribute('aria-label', `Copy the ${label} code`);

	header.append(name, button);
	// Replace the block with the wrapper, then put it back inside: the block keeps
	// its identity, so anything already holding a reference to it still works.
	pre.replaceWith(wrapper);
	wrapper.append(header, pre);

	let restore: ReturnType<typeof setTimeout> | undefined;
	button.addEventListener('click', async () => {
		const code = pre.querySelector('code');
		const copied = await copyText(code?.textContent ?? '');

		clearTimeout(restore);
		button.textContent = copied ? 'Copied' : 'Press Ctrl+C';
		button.dataset.state = copied ? 'copied' : 'failed';
		restore = setTimeout(() => {
			button.textContent = 'Copy';
			delete button.dataset.state;
		}, COPIED_FOR_MS);
	});

	return wrapper;
}
