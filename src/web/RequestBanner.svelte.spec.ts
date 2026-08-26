// The app's real stylesheet, so the mobile assertions below measure what a
// phone would actually get rather than an unstyled DOM: `min-h-11` is only 44px
// if Tailwind is present.
import '../http/routes/app.css';
import { render } from 'vitest-browser-svelte';
import { describe, expect, it } from 'vitest';
import RequestBanner from './RequestBanner.svelte';
import { Requests } from './requests.svelte';
import { FakeStream, aRequest, fakeActions, fakeRequestsApi } from './testing';
import type { RequestView } from './types';

/**
 * The sticky top banner (design §5, §7).
 *
 * The store is the real one, wired to a fake endpoint and a fake stream, so what
 * these specs assert about live behaviour is the production rule rather than a
 * stand-in for it. The actions are faked: what reaches the server is asserted as
 * a call, because the server's own checking of it is `src/http/owner/`'s job and
 * `src/domain/`'s guarantee.
 */
function mount(options: { requests?: RequestView[]; agentNames?: Record<string, string> } = {}) {
	const api = fakeRequestsApi({ seq: 4, requests: options.requests ?? [aRequest()] });
	const stream = new FakeStream();
	const requests = new Requests({
		fetch: api.fetch,
		openStream: () => stream,
		schedule: (run) => api.queue.push(run),
		notify: null
	});
	const acts = fakeActions();

	requests.hydrate(api.snapshot());

	return {
		api,
		stream,
		requests,
		acts,
		screen: render(RequestBanner, {
			requests,
			agentNames: options.agentNames ?? { a1: 'scout' },
			actions: acts.actions
		})
	};
}

describe('the banner exists only when an agent is blocked', () => {
	it('renders nothing at all when nothing is waiting', async () => {
		const { screen } = mount({ requests: [] });

		await expect.element(screen.getByTestId('request-banner')).not.toBeInTheDocument();
	});

	it('names the agent that is stopped, and asks its question', async () => {
		const { screen } = mount({
			requests: [aRequest({ question: 'Push to main?' })],
			agentNames: { a1: 'scout' }
		});

		await expect.element(screen.getByText('Push to main?')).toBeInTheDocument();
		await expect.element(screen.getByText(/scout is blocked/)).toBeInTheDocument();
	});

	it('shows the detail the agent wrote under the question', async () => {
		const { screen } = mount({
			requests: [aRequest({ detail: 'The diff touches the release workflow.' })]
		});

		await expect
			.element(screen.getByText('The diff touches the release workflow.'))
			.toBeInTheDocument();
	});
});

describe('each kind renders its own control (design §7)', () => {
	it('confirm offers approve and reject, and sends a boolean', async () => {
		const { screen, acts } = mount({ requests: [aRequest({ kind: 'confirm' })] });

		await screen.getByRole('button', { name: 'Approve' }).click();

		expect(acts.calls).toEqual([{ name: 'answerRequest', args: ['r1', true] }]);
	});

	it('confirm can also say no, which is an answer rather than a dismissal', async () => {
		const { screen, acts } = mount({ requests: [aRequest({ kind: 'confirm' })] });

		await screen.getByRole('button', { name: 'Reject' }).click();

		expect(acts.calls).toEqual([{ name: 'answerRequest', args: ['r1', false] }]);
	});

	it('buttons renders one button per action and sends the one clicked', async () => {
		const { screen, acts } = mount({
			requests: [
				aRequest({
					kind: 'buttons',
					question: 'The build failed',
					options: ['retry', 'skip', 'abort']
				})
			]
		});

		await expect.element(screen.getByRole('button', { name: 'skip' })).toBeInTheDocument();
		await screen.getByRole('button', { name: 'abort' }).click();

		expect(acts.calls).toEqual([{ name: 'answerRequest', args: ['r1', 'abort'] }]);
	});

	it('text takes what the owner types, trimmed', async () => {
		const { screen, acts } = mount({
			requests: [aRequest({ kind: 'text', question: 'Commit message?' })]
		});

		await screen.getByRole('textbox', { name: 'Your answer' }).fill('  fix: the parser  ');
		await screen.getByRole('button', { name: 'Send' }).click();

		expect(acts.calls).toEqual([{ name: 'answerRequest', args: ['r1', 'fix: the parser'] }]);
	});

	it('text pre-fills the default the agent suggested', async () => {
		const { screen, acts } = mount({
			requests: [
				aRequest({ kind: 'text', question: 'Commit message?', config: { default: 'fix: parser' } })
			]
		});

		await screen.getByRole('button', { name: 'Send' }).click();

		expect(acts.calls).toEqual([{ name: 'answerRequest', args: ['r1', 'fix: parser'] }]);
	});

	it('text gives a textarea when the agent asked for one', async () => {
		const { screen } = mount({
			requests: [aRequest({ kind: 'text', config: { multiline: true, placeholder: 'why?' } })]
		});

		const box = screen.getByRole('textbox', { name: 'Your answer' }).element();
		expect(box.tagName).toBe('TEXTAREA');
		expect(box.getAttribute('placeholder')).toBe('why?');
	});

	it('choice is a radio list, and sends the one selected', async () => {
		const { screen, acts } = mount({
			requests: [aRequest({ kind: 'choice', question: 'Which branch?', options: ['main', 'next'] })]
		});

		await screen.getByRole('radio', { name: 'next' }).click();
		await screen.getByRole('button', { name: 'Send' }).click();

		expect(acts.calls).toEqual([{ name: 'answerRequest', args: ['r1', 'next'] }]);
	});

	it('multi_choice is a checkbox list, and sends every option ticked', async () => {
		const { screen, acts } = mount({
			requests: [
				aRequest({
					kind: 'multi_choice',
					question: 'Delete which?',
					options: ['a.ts', 'b.ts', 'c.ts']
				})
			]
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
			requests: [
				aRequest({ kind: 'multi_choice', options: ['a', 'b', 'c'], config: { min: 2, max: 3 } })
			]
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
			requests: [
				aRequest({ kind: 'multi_choice', options: ['a', 'b'], config: { min: 1, max: 1 } })
			]
		});

		await expect
			.element(screen.getByTestId('request-bounds'))
			.toHaveTextContent('Choose between 1 and 1.');
	});

	it('will not send an empty text answer', async () => {
		const { screen } = mount({ requests: [aRequest({ kind: 'text' })] });

		await expect.element(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
	});
});

describe('several outstanding requests queue rather than overwrite (design §7)', () => {
	const three = [
		aRequest({ id: 'r1', seq: 1, question: 'Push to main?' }),
		aRequest({
			id: 'r2',
			seq: 2,
			agentId: 'a2',
			question: 'Which branch?',
			kind: 'choice',
			options: ['main', 'next']
		}),
		aRequest({ id: 'r3', seq: 3, agentId: 'a3', question: 'Commit message?', kind: 'text' })
	];

	it('answers the longest-blocked agent first and keeps the rest reachable', async () => {
		const { screen } = mount({
			requests: three,
			agentNames: { a1: 'scout', a2: 'nova', a3: 'pilot' }
		});

		// The front of the queue is the one with a control on it.
		await expect.element(screen.getByText('Push to main?')).toBeInTheDocument();
		await expect.element(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
		// And none of the others has been lost.
		await expect.element(screen.getByTestId('request-count')).toHaveTextContent('3 requests');
		await expect
			.element(screen.getByRole('button', { name: /nova: Which branch\?/ }))
			.toBeInTheDocument();
		await expect
			.element(screen.getByRole('button', { name: /pilot: Commit message\?/ }))
			.toBeInTheDocument();
	});

	it('brings a queued request to the front when the owner picks it', async () => {
		const { screen, acts } = mount({ requests: three, agentNames: { a2: 'nova' } });

		await screen.getByRole('button', { name: /nova: Which branch\?/ }).click();
		await screen.getByRole('radio', { name: 'next' }).click();
		await screen.getByRole('button', { name: 'Send' }).click();

		expect(acts.calls).toEqual([{ name: 'answerRequest', args: ['r2', 'next'] }]);
	});

	it('keeps each request’s draft separate while the owner moves between them', async () => {
		const { screen, acts } = mount({
			requests: [
				aRequest({ id: 'r1', seq: 1, kind: 'text', question: 'Commit message?' }),
				aRequest({ id: 'r2', seq: 2, kind: 'text', question: 'Branch name?' })
			]
		});

		await screen.getByRole('textbox', { name: 'Your answer' }).fill('fix: the parser');
		await screen.getByRole('button', { name: /Branch name\?/ }).click();
		await screen.getByRole('textbox', { name: 'Your answer' }).fill('release/1.2');
		await screen.getByRole('button', { name: 'Send' }).click();

		expect(acts.calls).toEqual([{ name: 'answerRequest', args: ['r2', 'release/1.2'] }]);
	});

	it('promotes the next one when the queue changes on the stream', async () => {
		const { api, stream, requests, screen } = mount({ requests: three });
		requests.start();

		api.replace(three.slice(1), 9);
		stream.emit('request.answered', { seq: 9, payload: { requestId: 'r1', state: 'answered' } });
		await api.settle();

		await expect.element(screen.getByText('Which branch?')).toBeInTheDocument();
		await expect.element(screen.getByText('Push to main?')).not.toBeInTheDocument();
		requests.stop();
	});
});

describe('dismissing, and refusals', () => {
	it('dismisses without answering', async () => {
		const { screen, acts } = mount();

		await screen.getByRole('button', { name: 'Dismiss' }).click();

		expect(acts.calls).toEqual([{ name: 'dismissRequest', args: ['r1'] }]);
	});

	it('shows a refusal and keeps what the owner typed', async () => {
		const { screen, acts } = mount({ requests: [aRequest({ kind: 'text' })] });
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
			requests: [
				aRequest({
					kind: 'buttons',
					question: 'a question long enough to wrap several times over on a narrow screen',
					detail: 'and-a-detail-with-an-unbreakable-token-'.repeat(4),
					options: ['retry the whole build', 'skip this step', 'abort']
				})
			]
		});
		const banner = screen.getByTestId('request-banner').element() as HTMLElement;
		banner.style.width = '360px';

		expect(banner.scrollWidth).toBeLessThanOrEqual(banner.clientWidth + 1);

		for (const name of ['retry the whole build', 'abort', 'Dismiss']) {
			const button = screen.getByRole('button', { name }).element() as HTMLElement;
			// Rounded: 2.75rem lands a few ten-thousandths under 44 in a real layout.
			expect(Math.round(button.getBoundingClientRect().height), name).toBeGreaterThanOrEqual(44);
		}
	});
});
