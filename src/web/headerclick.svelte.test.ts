import { describe, expect, it } from 'vitest';
import { foldsOnClick } from './headerclick';

/**
 * Which clicks on a card header fold it (design §7).
 *
 * The owner: "clicking on any empty part (or the title) of the header of a card
 * should collapse and expand it."
 */
function clickOn(html: string, selector: string, detail = 1): boolean {
	const header = document.createElement('header');
	header.innerHTML = html;
	document.body.append(header);
	try {
		const target = header.querySelector(selector) ?? header;
		return foldsOnClick({ target, detail } as unknown as MouseEvent);
	} finally {
		header.remove();
	}
}

describe('folding by clicking the header', () => {
	it('folds on the empty part', () => {
		expect(clickOn('<span id="name">scout</span>', '#name')).toBe(true);
	});

	it('leaves a button to do its own job', () => {
		expect(clickOn('<button id="pin">Pin</button>', '#pin')).toBe(false);
	});

	it('leaves something inside a button alone too', () => {
		expect(clickOn('<button><svg id="icon"></svg></button>', '#icon')).toBe(false);
	});

	it('leaves links and fields alone', () => {
		expect(clickOn('<a id="x" href="#">go</a>', '#x')).toBe(false);
		expect(clickOn('<input id="x" />', '#x')).toBe(false);
		expect(clickOn('<span id="x" role="button">menu</span>', '#x')).toBe(false);
	});

	it('does not fold under a double click, which is how a word is selected', () => {
		expect(clickOn('<span id="name">scout</span>', '#name', 2)).toBe(false);
	});

	it('shrugs off a click with no element behind it', () => {
		expect(foldsOnClick({ target: null, detail: 1 } as unknown as MouseEvent)).toBe(false);
	});
});
