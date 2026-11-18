/**
 * Agent markdown as plain text, for places that cannot render it: a phone's
 * notification shows `**done**` with the asterisks.
 *
 * Parsed rather than pattern-stripped, so `2 * 3 * 4` and a literal `_` in a
 * file name survive while real emphasis goes. Each block becomes one line;
 * list items get a bullet so a list still reads as one.
 */
import MarkdownIt from 'markdown-it';

// The same reading the timeline uses, so a notification says what the card says.
const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

type Token = ReturnType<typeof md.parse>[number];

export function markdownToPlainText(markdown: string): string {
	const lines: string[] = [];
	let bullet = '';

	for (const token of md.parse(markdown, {})) {
		switch (token.type) {
			case 'list_item_open':
				bullet = token.markup === '.' || token.markup === ')' ? `${token.info}. ` : '• ';
				break;
			case 'inline':
				lines.push(bullet + inlineText(token.children ?? []));
				bullet = '';
				break;
			case 'fence':
			case 'code_block':
				lines.push(token.content.trimEnd());
				break;
		}
	}

	return lines
		.map((line) => line.trim())
		.filter((line) => line !== '')
		.join('\n');
}

function inlineText(children: Token[]): string {
	let text = '';
	for (const child of children) {
		if (child.type === 'text' || child.type === 'code_inline') text += child.content;
		else if (child.type === 'softbreak' || child.type === 'hardbreak') text += '\n';
		else if (child.type === 'image') text += child.content || 'image';
	}
	return text;
}
