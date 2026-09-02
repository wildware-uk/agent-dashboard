// The real stylesheet, so the thumb-target assertion measures what a phone gets.
import '../http/routes/app.css';
import { render } from 'vitest-browser-svelte';
import { describe, expect, it } from 'vitest';
import Composer from './Composer.svelte';
import { aProject, fakeActions } from './testing';

/**
 * The box at the top of the feed (design §7).
 *
 * It posts a **message**, not a task, and that is the assertion that matters.
 * It created a task first, which made the owner do the triage — deciding
 * whether a sentence deserves a task, what to call it and who it is for is the
 * agent's job.
 */
function mount(project: string | null = 'agent-dashboard') {
	const acts = fakeActions();
	return {
		acts,
		screen: render(Composer, {
			project,
			projects: [
				aProject({ slug: 'agent-dashboard', name: 'Agent Dashboard' }),
				aProject({ id: 'p2', slug: 'melon', name: 'Melon' })
			],
			actions: acts.actions
		})
	};
}

const box = () => document.querySelector('[data-composer] textarea') as HTMLTextAreaElement;

describe('posting to the feed', () => {
	it('posts a message to the project, and creates no task', async () => {
		const { acts, screen } = mount();

		await screen.getByRole('textbox').fill('have a look at the flaky migration test');
		await screen.getByRole('button', { name: 'Post' }).click();

		expect(acts.calls).toEqual([
			{
				name: 'postMessage',
				args: [{ project: 'agent-dashboard', body: 'have a look at the flaky migration test' }]
			}
		]);
	});

	it('keeps the whole thing, with no title split', async () => {
		const { acts, screen } = mount();

		await screen.getByRole('textbox').fill('first line\n\nand a second paragraph');
		await screen.getByRole('button', { name: 'Post' }).click();

		expect(acts.calls[0].args[0]).toMatchObject({ body: 'first line\n\nand a second paragraph' });
	});

	it('sends on Ctrl+Enter and leaves plain Enter as a newline', async () => {
		const { acts, screen } = mount();
		const field = screen.getByRole('textbox');

		await field.fill('a thought');
		field
			.element()
			.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
			);
		expect(acts.calls).toEqual([]);

		field.element().dispatchEvent(
			new KeyboardEvent('keydown', {
				key: 'Enter',
				ctrlKey: true,
				bubbles: true,
				cancelable: true
			})
		);
		await expect.poll(() => acts.calls.length).toBe(1);
	});

	it('empties the box once it has landed', async () => {
		const { screen } = mount();

		await screen.getByRole('textbox').fill('a thought');
		await screen.getByRole('button', { name: 'Post' }).click();

		await expect.poll(() => box().value).toBe('');
	});

	it('refuses to post nothing', async () => {
		const { acts, screen } = mount();

		await screen.getByRole('textbox').fill('   ');

		await expect.element(screen.getByRole('button', { name: 'Post' })).toBeDisabled();
		expect(acts.calls).toEqual([]);
	});

	it('keeps what was typed when the server refuses, and says why', async () => {
		const { screen, acts } = mount();
		acts.fail(new Error('no such project'));

		await screen.getByRole('textbox').fill('a thought');
		await screen.getByRole('button', { name: 'Post' }).click();

		await expect.element(screen.getByText('no such project')).toBeInTheDocument();
		expect(box().value).toBe('a thought');
	});

	it('gives the post control a thumb-sized target, measured', async () => {
		const { screen } = mount();

		const button = screen.getByRole('button', { name: 'Post' }).element();
		expect(Math.round(button.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
	});
});

describe('on the all-projects view', () => {
	it('asks which project, because there is no answer on screen', async () => {
		const { screen } = mount(null);

		await expect.element(screen.getByLabelText('Project to post in')).toBeInTheDocument();
	});

	it('will not post until one is chosen', async () => {
		const { acts, screen } = mount(null);

		await screen.getByRole('textbox').fill('a thought');
		await expect.element(screen.getByRole('button', { name: 'Post' })).toBeDisabled();

		await screen.getByLabelText('Project to post in').selectOptions('Melon');
		await screen.getByRole('button', { name: 'Post' }).click();

		expect(acts.calls[0].args[0]).toMatchObject({ project: 'melon' });
	});

	it('does not ask when a project is already on screen', async () => {
		mount('agent-dashboard');

		expect(document.querySelector('[data-composer] select')).toBeNull();
	});
});

/**
 * Cmd as well as Ctrl (#feedback: "allow CMD + Enter to also post").
 *
 * Both have always been accepted; the placeholder only named one, which is the
 * same bug as far as anyone using it is concerned — a control nobody knows about
 * does not exist.
 */
describe('the send chord', () => {
	it('posts on Cmd+Enter', async () => {
		const { acts, screen } = mount();
		const field = screen.getByRole('textbox');

		await field.fill('a thought');
		field.element().dispatchEvent(
			new KeyboardEvent('keydown', {
				key: 'Enter',
				metaKey: true,
				bubbles: true,
				cancelable: true
			})
		);

		await expect.poll(() => acts.calls.length).toBe(1);
	});

	it('says both in the box, so neither has to be guessed', async () => {
		mount();

		const placeholder = box().getAttribute('placeholder') ?? '';
		expect(placeholder).toContain('Cmd');
		expect(placeholder).toContain('Ctrl');
	});
});
