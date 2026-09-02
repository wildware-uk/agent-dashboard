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

/**
 * How much of a body a link preview carries.
 *
 * Long enough to say what the card is about, short enough that Slack, iMessage
 * and the rest do not truncate it themselves with an ellipsis of their own.
 */
export const EXCERPT_MAX_LENGTH = 200;

/**
 * A plain-text opening for a link preview (design §7).
 *
 * Not rendered markdown and not raw markdown either: an unfurled link shows text
 * in somebody else's chat window, so `## Deployed` reading as "## Deployed" is a
 * worse answer than "Deployed", and any tag that survived would be shown as
 * literal characters at best.
 *
 * The stripping is deliberately shallow. This is a summary, not a second
 * renderer — anything it cannot flatten (a table, a nested list) it simply
 * leaves as the words in it, which still reads. What it must never carry is
 * markup, which is why tag-shaped runs go too: the renderer escapes those rather
 * than executing them, but a preview is text in somebody else's app and has no
 * use for the characters.
 */
export function excerpt(body: string, maxLength = EXCERPT_MAX_LENGTH): string {
	const flattened = body
		// Fenced code: the fence and the language tag say nothing worth showing.
		.replace(/```[\s\S]*?```/g, ' ')
		// Anything tag-shaped. The renderer escapes these rather than executing
		// them (`html: false`), so they are only ever literal characters — but a
		// preview reading "<script>alert(1)</script>" in somebody's chat window is
		// noise at best. Tag-shaped rather than any `<`, so "a < b" survives.
		.replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
		.replace(/`([^`]*)`/g, '$1')
		// Images before links: an image is `![alt](src)` and would otherwise leave
		// a stray `!` behind when the link body is unwrapped.
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		// Heading hashes, blockquote markers and list bullets, at line starts only,
		// so a mid-sentence `#` or `-` survives.
		.replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/gm, '')
		// Emphasis and strikethrough markers around a run of text.
		.replace(/(\*\*|__|~~|[*_])(\S(?:.*?\S)?)\1/g, '$2')
		// Horizontal rules leave nothing behind at all.
		.replace(/^\s*([-*_])\s*(?:\1\s*){2,}$/gm, ' ')
		.replace(/\s+/g, ' ')
		.trim();

	if (flattened.length <= maxLength) return flattened;

	// Cut at a word, not mid-word, and only if there is a word boundary worth
	// cutting at — a 200-character token has no better break than its middle.
	const cut = flattened.slice(0, maxLength);
	const space = cut.lastIndexOf(' ');
	return `${(space > maxLength * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
