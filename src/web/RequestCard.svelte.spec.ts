// The app's real stylesheet, so the mobile assertions below measure what a
// phone would actually get rather than an unstyled DOM: `min-h-11` is only 44px
// if Tailwind is present.
import '../http/routes/app.css';
import { render } from 'vitest-browser-svelte';
import { describe, expect, it } from 'vitest';
import RequestCard from './RequestCard.svelte';
import { aRequest, fakeActions } from './testing';
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
		const { screen } = mount({}, { projectName: 'Mega Merge' });

		await expect.element(screen.getByTestId('request-project')).toHaveTextContent('Mega Merge');
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
