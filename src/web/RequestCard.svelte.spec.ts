// The app's real stylesheet, so the mobile assertions below measure what a
// phone would actually get rather than an unstyled DOM: `min-h-11` is only 44px
// if Tailwind is present.
import '../http/routes/app.css';
import { render } from 'vitest-browser-svelte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import RequestCard from './RequestCard.svelte';
import { aMedia, aMessage, aRequest, anEmbed, fakeActions, insideTheApp } from './testing';
import type { RequestView } from './types';

/**
 * One request, as a card in the feed (design §5, §7).
 *
 * No store here, unlike the banner these specs replaced: a card renders the row
 * it was handed and nothing else, and which rows reach it is the shell's
 * question (`Shell.svelte.spec.ts`) and the feed's (`Timeline.svelte.spec.ts`).
 * The actions are faked: what reaches the server is asserted as a call, because
 * the server's own checking of it is `src/http/owner/`'s job and
 * `src/domain/`'s guarantee.
 */
function mount(request: Partial<RequestView> = {}, props: Record<string, unknown> = {}) {
	const acts = fakeActions();

	return {
		acts,
		screen: render(RequestCard, {
			request: aRequest(request),
			agentName: 'scout',
			actions: acts.actions,
			...props
		})
	};
}

describe('the card says who is blocked, and on what', () => {
	it('names the agent and asks its question', async () => {
		const { screen } = mount({ question: 'Push to main?' });

		await expect.element(screen.getByText('Push to main?')).toBeInTheDocument();
		await expect.element(screen.getByText('scout')).toBeInTheDocument();
		await expect.element(screen.getByText('Waiting on you')).toBeInTheDocument();
	});

	it('shows the detail the agent wrote under the question', async () => {
		const { screen } = mount({ detail: 'The diff touches the release workflow.' });

		await expect
			.element(screen.getByText('The diff touches the release workflow.'))
			.toBeInTheDocument();
	});

	it('says how long is left to answer', async () => {
		// Half a minute of headroom: the label floors to whole minutes, and a render
		// that starts a few hundred milliseconds after this line would otherwise
		// read 41m on a loaded machine.
		const { screen } = mount({ expiresAt: Date.now() + 42 * 60_000 + 30_000 });

		await expect.element(screen.getByTestId('request-expiry')).toHaveTextContent('expires in 42m');
	});

	it('names the project only when it is told one', async () => {
		const { screen } = mount({}, { projectName: 'Garden Game' });

		await expect.element(screen.getByTestId('request-project')).toHaveTextContent('Garden Game');
	});

	it('leaves the project out on a feed that is already one project', async () => {
		const { screen } = mount();

		await expect.element(screen.getByTestId('request-project')).not.toBeInTheDocument();
	});
});

describe('each kind renders its own control (design §7)', () => {
	it('confirm offers approve and reject, and sends a boolean', async () => {
		const { screen, acts } = mount({ kind: 'confirm' });

		await screen.getByRole('button', { name: 'Approve' }).click();

		expect(acts.calls).toEqual([{ name: 'answerRequest', args: ['r1', true] }]);
	});

	it('confirm can also say no, which is an answer rather than a dismissal', async () => {
		const { screen, acts } = mount({ kind: 'confirm' });

		await screen.getByRole('button', { name: 'Reject' }).click();

		expect(acts.calls).toEqual([{ name: 'answerRequest', args: ['r1', false] }]);
	});

	it('buttons renders one button per action and sends the one clicked', async () => {
		const { screen, acts } = mount({
			kind: 'buttons',
			question: 'The build failed',
			options: ['retry', 'skip', 'abort']
		});

		await expect.element(screen.getByRole('button', { name: 'skip' })).toBeInTheDocument();
		await screen.getByRole('button', { name: 'abort' }).click();

		expect(acts.calls).toEqual([{ name: 'answerRequest', args: ['r1', 'abort'] }]);
	});

	it('text takes what the owner types, trimmed', async () => {
		const { screen, acts } = mount({ kind: 'text', question: 'Commit message?' });

		await screen.getByRole('textbox', { name: 'Your answer' }).fill('  fix: the parser  ');
		await screen.getByRole('button', { name: 'Send' }).click();

		expect(acts.calls).toEqual([{ name: 'answerRequest', args: ['r1', 'fix: the parser'] }]);
	});

	it('text pre-fills the default the agent suggested', async () => {
		const { screen, acts } = mount({
			kind: 'text',
			question: 'Commit message?',
			config: { default: 'fix: parser' }
		});

		await screen.getByRole('button', { name: 'Send' }).click();

		expect(acts.calls).toEqual([{ name: 'answerRequest', args: ['r1', 'fix: parser'] }]);
	});

	it('text gives a textarea when the agent asked for one', async () => {
		const { screen } = mount({ kind: 'text', config: { multiline: true, placeholder: 'why?' } });

		const box = screen.getByRole('textbox', { name: 'Your answer' }).element();
		expect(box.tagName).toBe('TEXTAREA');
		expect(box.getAttribute('placeholder')).toBe('why?');
	});

	it('choice is a radio list, and sends the one selected', async () => {
		const { screen, acts } = mount({
			kind: 'choice',
			question: 'Which branch?',
			options: ['main', 'next']
		});

		await screen.getByRole('radio', { name: 'next' }).click();
		await screen.getByRole('button', { name: 'Send' }).click();

		expect(acts.calls).toEqual([{ name: 'answerRequest', args: ['r1', 'next'] }]);
	});

	it('multi_choice is a checkbox list, and sends every option ticked', async () => {
		const { screen, acts } = mount({
			kind: 'multi_choice',
			question: 'Delete which?',
			options: ['a.ts', 'b.ts', 'c.ts']
		});

		await screen.getByRole('checkbox', { name: 'a.ts' }).click();
		await screen.getByRole('checkbox', { name: 'c.ts' }).click();
		await screen.getByRole('button', { name: 'Send' }).click();

		expect(acts.calls).toEqual([{ name: 'answerRequest', args: ['r1', ['a.ts', 'c.ts']] }]);
	});
});

describe('min and max, as a courtesy before the click', () => {
	it('will not send fewer than the agent asked for', async () => {
		const { screen, acts } = mount({
			kind: 'multi_choice',
			options: ['a', 'b', 'c'],
			config: { min: 2, max: 3 }
		});

		const send = screen.getByRole('button', { name: 'Send' });
		await expect.element(send).toBeDisabled();
		await screen.getByRole('checkbox', { name: 'a' }).click();
		await expect.element(send).toBeDisabled();
		await screen.getByRole('checkbox', { name: 'b' }).click();
		await expect.element(send).toBeEnabled();

		await send.click();
		expect(acts.calls).toEqual([{ name: 'answerRequest', args: ['r1', ['a', 'b']] }]);
	});

	it('says what the bounds are rather than leaving a dead button unexplained', async () => {
		const { screen } = mount({
			kind: 'multi_choice',
			options: ['a', 'b'],
			config: { min: 1, max: 1 }
		});

		await expect
			.element(screen.getByTestId('request-bounds'))
			.toHaveTextContent('Choose between 1 and 1.');
	});

	it('will not send an empty text answer', async () => {
		const { screen } = mount({ kind: 'text' });

		await expect.element(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
	});
});

describe('dismissing, and refusals', () => {
	it('dismisses without answering', async () => {
		const { screen, acts } = mount();

		await screen.getByRole('button', { name: 'Dismiss' }).click();

		expect(acts.calls).toEqual([{ name: 'dismissRequest', args: ['r1'] }]);
	});

	it('shows a refusal and keeps what the owner typed', async () => {
		const { screen, acts } = mount({ kind: 'text' });
		acts.fail(new Error('the server said no'));

		await screen.getByRole('textbox', { name: 'Your answer' }).fill('fix: the parser');
		await screen.getByRole('button', { name: 'Send' }).click();

		await expect.element(screen.getByRole('alert')).toBeInTheDocument();
		await expect
			.element(screen.getByRole('textbox', { name: 'Your answer' }))
			.toHaveValue('fix: the parser');
	});
});

describe('on a phone', () => {
	it('fits 360px, wraps its actions, and keeps 44px targets', async () => {
		const { screen } = mount({
			kind: 'buttons',
			question: 'a question long enough to wrap several times over on a narrow screen',
			detail: 'and-a-detail-with-an-unbreakable-token-'.repeat(4),
			options: ['retry the whole build', 'skip this step', 'abort']
		});
		const card = screen.getByTestId('request-card').element() as HTMLElement;
		card.style.width = '360px';

		expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth + 1);

		for (const name of ['retry the whole build', 'abort', 'Dismiss']) {
			const button = screen.getByRole('button', { name }).element() as HTMLElement;
			// Rounded: 2.75rem lands a few ten-thousandths under 44 in a real layout.
			expect(Math.round(button.getBoundingClientRect().height), name).toBeGreaterThanOrEqual(44);
		}
	});
});

/**
 * `form`: an editable draft and the agent's own actions, answered together.
 */
describe('a form request', () => {
	const form = (over: Partial<RequestView> = {}) =>
		mount({
			kind: 'form',
			question: 'Send this to #general?',
			options: ['Approve', 'Reject'],
			config: {
				default: 'Deploy is done.',
				label: 'Message',
				multiline: true
			},
			...over
		});

	it('shows the draft in a named, editable field', async () => {
		const { screen } = form();

		await expect.element(screen.getByText('Message')).toBeInTheDocument();
		await expect
			.element(screen.getByRole('textbox', { name: 'Message' }))
			.toHaveValue('Deploy is done.');
	});

	it('renders the agent’s own action labels, not Send', async () => {
		const { screen } = form();

		await expect.element(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
		await expect.element(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
		await expect.element(screen.getByRole('button', { name: 'Send' })).not.toBeInTheDocument();
	});

	it('sends the action and the edited text as one answer', async () => {
		const { screen, acts } = form();

		await screen.getByRole('textbox', { name: 'Message' }).fill('Deploy done. No rollbacks.');
		await screen.getByRole('button', { name: 'Approve' }).click();

		expect(acts.calls).toEqual([
			{
				name: 'answerRequest',
				args: ['r1', { action: 'Approve', text: 'Deploy done. No rollbacks.' }]
			}
		]);
	});

	it('sends the draft untouched when the owner changed nothing', async () => {
		const { screen, acts } = form();

		await screen.getByRole('button', { name: 'Approve' }).click();

		expect(acts.calls).toEqual([
			{ name: 'answerRequest', args: ['r1', { action: 'Approve', text: 'Deploy is done.' }] }
		]);
	});

	it('falls back to a generic field name when the agent named none', async () => {
		const { screen } = form({ config: { default: 'x' } });

		await expect.element(screen.getByRole('textbox', { name: 'Your answer' })).toBeInTheDocument();
	});

	it('holds the actions until the text meets the agent’s minimum', async () => {
		const { screen } = form({ config: { default: '', min: 5 } });
		const approve = screen.getByRole('button', { name: 'Approve' });

		await expect.element(approve).toBeDisabled();
		await screen.getByRole('textbox', { name: 'Your answer' }).fill('long enough');

		await expect.element(approve).toBeEnabled();
	});
});

/**
 * An approval carrying what every other card carries (migration 030).
 *
 * The owner: "approval boxes cannot contain embeds, standardize the approach on
 * cards, all card types support all the same things." There was no decision
 * behind the gap — media and embeds landed on updates and messages, and the card
 * types nobody was looking at were left behind.
 */
describe('what an approval can show', () => {
	it('renders its detail as markdown, as every other card does', async () => {
		const screen = render(RequestCard, {
			request: aRequest({ detail: 'The **canary** held for 20 minutes.' }),
			actions: fakeActions().actions
		});

		// Plain text until now, for no reason anybody had decided.
		await expect.element(screen.getByText('canary')).toBeInTheDocument();
		expect(document.querySelector('[data-request-id] strong')).not.toBeNull();
	});

	it('shows the thing it is asking about', async () => {
		render(RequestCard, {
			request: aRequest({
				media: [aMedia({ id: 'shot', updateId: null })],
				embeds: [anEmbed({ id: 'e1' })]
			}),
			actions: fakeActions().actions
		});

		// "Does this look right" is a question you cannot ask without the thing
		// being looked at.
		expect(document.querySelector('[data-media-tile="shot"]')).not.toBeNull();
		expect(document.querySelector('[data-embed="e1"]')).not.toBeNull();
	});

	it('is unchanged when it carries nothing, which is the ordinary case', async () => {
		render(RequestCard, { request: aRequest(), actions: fakeActions().actions });

		expect(document.querySelector('[data-media-grid]')).toBeNull();
		expect(document.querySelector('[data-embeds]')).toBeNull();
	});
});

/**
 * Talking a question over before answering it (migration 032).
 *
 * The owner: "allow me to reply to form questions, so I can discuss with the
 * agent before giving the answer." The buttons were the only thing you could
 * say back, so asking "why?" meant answering something first.
 */
/**
 * A question the asking agent rewrote (migration 033).
 *
 * An owner half way through deciding has to be able to tell that what they are
 * answering has moved under them.
 */
describe('a question that has been corrected', () => {
	it('says so on the card', async () => {
		const { screen } = mount({ editedAt: Date.now() });

		await expect.element(screen.getByTestId('request-edited')).toBeInTheDocument();
	});

	it('says nothing on one nobody has touched, which is nearly all of them', async () => {
		const { screen } = mount();

		expect(screen.container.querySelector('[data-testid="request-edited"]')).toBeNull();
	});
});

describe('discussing a question instead of answering it', () => {
	it('offers a reply box under the controls, with nothing said yet', async () => {
		const { screen } = mount({ kind: 'form', options: ['Send', 'Cancel'] });

		await expect.element(screen.getByRole('button', { name: 'Reply' })).toBeInTheDocument();
		// The answer is still what the agent is waiting for: the buttons stay.
		await expect.element(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
	});

	it('posts what the owner types against the question, not against a card', async () => {
		const { acts, screen } = mount({ id: 'r1' });

		await screen.getByRole('button', { name: 'Reply' }).click();
		await screen.getByRole('textbox', { name: /reply/i }).fill('why that wording?');
		await screen.getByRole('button', { name: 'Send reply' }).click();

		await expect
			.poll(() => acts.calls.find((call) => call.name === 'postMessage')?.args[0])
			.toMatchObject({ request: 'r1', body: 'why that wording?' });
	});

	it('shows what has been said so far', async () => {
		const { screen } = mount(
			{ id: 'r1' },
			{
				messages: [
					aMessage({ id: 'm1', author: 'human', updateId: null, body: 'why that wording?' }),
					aMessage({
						id: 'm2',
						author: 'agent:a1',
						updateId: null,
						body: 'because the ticket says so'
					})
				]
			}
		);

		await expect.element(screen.getByText('why that wording?')).toBeInTheDocument();
		await expect.element(screen.getByText('because the ticket says so')).toBeInTheDocument();
	});

	/**
	 * A question asked inside a thread (migration 022) already sits in a
	 * conversation, one reply box above the card. A second one would be two ways
	 * to say the same thing in the same place.
	 */
	it('carries no box of its own when it is already inside a thread', async () => {
		const inside = mount({}, { discussable: false });
		expect(inside.screen.container.querySelector('[data-thread]')).toBeNull();

		// The same card in the feed does carry one, so the assertion above is
		// about the flag rather than about the selector.
		const alone = mount();
		expect(alone.screen.container.querySelector('[data-thread]')).not.toBeNull();
	});
});

/**
 * The features every card shares, on a question (migration 034).
 *
 * The owner: "there are many discrepancies between the card types, they should
 * all share the same features." A question could be answered or dismissed and
 * nothing else — no pin, no emoji.
 */
describe('the shared controls on a question', () => {
	it('pins it, naming the card', async () => {
		const { acts, screen } = mount({ id: 'r4' });

		await screen.getByRole('button', { name: 'Pin question' }).click();

		expect(acts.calls.find((call) => call.name === 'pinCard')?.args).toEqual([
			'request',
			'r4',
			true
		]);
	});

	it('takes an emoji, like every other card', async () => {
		const { acts, screen } = mount({ id: 'r4' });

		await screen.getByRole('button', { name: 'Add a reaction' }).click();
		await screen.getByRole('button', { name: 'React 👀' }).click();

		expect(acts.calls.find((call) => call.name === 'reactToCard')?.args).toEqual([
			'request',
			'r4',
			'👀',
			undefined
		]);
	});
});

describe('a typed answer inside the iPhone app', () => {
	let app: ReturnType<typeof insideTheApp>;
	beforeEach(() => {
		app = insideTheApp();
	});
	afterEach(() => app.leave());

	it('is written in the app bar, starting from the suggested answer', async () => {
		const { screen, acts } = mount({
			kind: 'text',
			question: 'Commit message?',
			config: { default: 'fix: parser' }
		});

		await screen.getByRole('button', { name: 'Answer' }).click();

		expect(document.querySelector('input[type="text"], textarea')).toBeNull();
		expect(app.handed).toEqual([
			expect.objectContaining({ label: 'Answer scout', draft: 'fix: parser' })
		]);

		await app.type('fix: the parser');
		expect(acts.calls).toEqual([{ name: 'answerRequest', args: ['r1', 'fix: the parser'] }]);
	});
});

describe('a picture question', () => {
	const red = aMedia({ id: 'red', updateId: null, requestId: 'r1' });
	const blue = aMedia({ id: 'blue', updateId: null, requestId: 'r1' });
	const evidence = aMedia({ id: 'shot', updateId: null, requestId: 'r1' });

	it('puts each picture on its button, and answers with the option', async () => {
		const { screen, acts } = mount({
			kind: 'buttons',
			options: ['Red logo', 'Blue logo'],
			config: { optionMedia: { 'Red logo': 'red', 'Blue logo': 'blue' } },
			media: [red, blue]
		});

		const button = screen.getByRole('button', { name: 'Red logo' });
		expect(button.element().querySelector('img')?.getAttribute('src')).toContain('/media/red/');
		await button.click();

		expect(acts.calls).toEqual([{ name: 'answerRequest', args: ['r1', 'Red logo'] }]);
	});

	it('shows option pictures on the options only, and the rest in the card', async () => {
		mount({
			kind: 'choice',
			options: ['Red', 'Blue'],
			config: { optionMedia: { Red: 'red', Blue: 'blue' } },
			media: [red, blue, evidence]
		});

		const shown = [...document.querySelectorAll('img')].map((img) => img.getAttribute('src'));
		expect(shown.filter((src) => src?.includes('/media/red/'))).toHaveLength(1);
		expect(shown.filter((src) => src?.includes('/media/shot/'))).toHaveLength(1);
	});
});
