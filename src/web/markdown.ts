/**
 * Rendering agent-authored markdown (design §7, §8).
 *
 * **Agents write this content, so it is untrusted input by definition.** The
 * renderer therefore runs with `html: false`, which is not a setting so much as
 * the whole security model of the timeline: markdown-it escapes every raw tag
 * instead of passing it through, so there is no sanitiser to keep up to date and
 * no allowlist to get wrong. `markdown.test.ts` pins that with the cases that
 * matter — a `<script>` body, an `onerror` attribute, a `javascript:` link.
 *
 * The output of `renderMarkdown` is the only string in the client that is ever
 * handed to `{@html …}` (see `Markdown.svelte`), which is what makes that one
 * decision auditable.
 */
import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({
	// The line this module exists to hold. Never turn it on.
	html: false,
	// Agents paste URLs; a bare one should be clickable.
	linkify: true,
	// Update bodies read like chat messages, so a single newline is a line break
	// rather than a paragraph continuation. Without this, an agent's carefully
	// laid out log lines collapse into one paragraph.
	breaks: true,
	typographer: false
});

/**
 * Every anchor leaves the dashboard, so every anchor is hardened.
 *
 * `noopener`/`noreferrer` keeps the opened page from reaching back through
 * `window.opener`; `nofollow ugc` says out loud that this link came from
 * user-generated content. markdown-it has already refused unsafe schemes by the
 * time this runs, so this is about the destination, not the protocol.
 */
md.renderer.rules.link_open = (tokens, index, options, _env, self) => {
	const token = tokens[index];
	token.attrSet('rel', 'noopener noreferrer nofollow ugc');
	token.attrSet('target', '_blank');
	return self.renderToken(tokens, index, options);
};

/**
 * Wrap every table in its own horizontal scroller.
 *
 * A table's min-content width is the sum of its columns, and a table that cannot
 * shrink drags the whole layout with it: on a 375px phone one five-column table
 * in an update pushed the layout viewport to 723px, so the browser zoomed the
 * entire dashboard out to fit. Wide content scrolls inside its own container
 * (design §7) — and note that a page-level overflow check does not catch this,
 * because the document and the viewport grow together.
 */
md.renderer.rules.table_open = () => '<div class="md-scroll"><table>';
md.renderer.rules.table_close = () => '</table></div>';

/**
 * Markdown to HTML, with raw HTML disabled.
 *
 * @param body markdown as an agent wrote it.
 * @returns HTML safe to inject, or `''` for a blank body — a card renders
 *   nothing at all rather than an empty paragraph.
 */
export function renderMarkdown(body: string): string {
	if (body.trim() === '') return '';
	return md.render(body);
}
