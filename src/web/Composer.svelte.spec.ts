// The real stylesheet, so the thumb-target assertion measures what a phone gets.
import '../http/routes/app.css';
import { render } from 'vitest-browser-svelte';
import { describe, expect, it, vi } from 'vitest';
import Composer from './Composer.svelte';
import { aProject, aTag, fakeActions } from './testing';

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
				aProject({ id: 'p2', slug: 'garden', name: 'Garden' })
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

		await screen.getByLabelText('Project to post in').selectOptions('Garden');
		await screen.getByRole('button', { name: 'Post' }).click();

		expect(acts.calls[0].args[0]).toMatchObject({ project: 'garden' });
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

/**
 * Images on a post (migration 016).
 *
 * The three ways in are three habits, and paste is the one that matters most:
 * it is how a screenshot actually arrives.
 */
describe('attaching images', () => {
	const png = (name = 'shot.png') =>
		new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' });

	function paste(files: File[]): void {
		const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
		Object.defineProperty(event, 'clipboardData', { value: { files } });
		box().dispatchEvent(event);
	}

	function drop(files: File[]): void {
		const event = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent;
		Object.defineProperty(event, 'dataTransfer', { value: { files } });
		box().dispatchEvent(event);
	}

	it('takes a pasted image and sends its id with the post', async () => {
		const { acts, screen } = mount();

		paste([png()]);
		await expect.poll(() => acts.calls.map((call) => call.name)).toContain('uploadMedia');

		await screen.getByRole('textbox').fill('look at this');
		await screen.getByRole('button', { name: 'Post' }).click();

		await expect
			.poll(() => acts.calls.find((call) => call.name === 'postMessage')?.args[0])
			.toMatchObject({ body: 'look at this', mediaIds: ['m-shot.png'] });
	});

	it('takes a dropped image too', async () => {
		const { acts } = mount();

		drop([png('dropped.png')]);

		await expect.poll(() => acts.calls.map((call) => call.name)).toContain('uploadMedia');
	});

	it('lets a picture be the whole post, with no words', async () => {
		const { acts, screen } = mount();

		paste([png()]);
		await expect.poll(() => acts.calls.length).toBe(1);

		await expect.element(screen.getByRole('button', { name: 'Post' })).toBeEnabled();
		await screen.getByRole('button', { name: 'Post' }).click();

		await expect
			.poll(() => acts.calls.find((call) => call.name === 'postMessage')?.args[0])
			.toMatchObject({ body: '', mediaIds: ['m-shot.png'] });
	});

	it('leaves a paste of plain text alone', async () => {
		const { acts } = mount();

		paste([]);

		expect(acts.calls).toEqual([]);
	});

	it('empties the tray once the post has landed', async () => {
		const { acts, screen } = mount();
		paste([png()]);
		await expect.poll(() => acts.calls.length).toBe(1);

		await screen.getByRole('button', { name: 'Post' }).click();

		await expect.poll(() => document.querySelectorAll('[data-attachments] li').length).toBe(0);
	});
});

/**
 * Labelling a post before it exists (migration 039).
 *
 * The owner: "let me set tags on a post before I actually post it."
 */
describe('tagging a post before posting it', () => {
	function withTags() {
		const acts = fakeActions();
		return {
			acts,
			screen: render(Composer, {
				project: 'agent-dashboard',
				projects: [aProject({ id: 'p1', slug: 'agent-dashboard', name: 'Agent Dashboard' })],
				tags: [
					aTag({ id: 't1', projectId: 'p1', name: 'Bug' }),
					aTag({ id: 't2', projectId: 'p1', name: 'Feature' })
				],
				actions: acts.actions
			})
		};
	}

	it('holds the chosen words, then puts them on the post it made', async () => {
		const { acts, screen } = withTags();

		await screen.getByTestId('tag-add').click();
		(document.querySelector('[data-pick="t1"]') as HTMLElement).click();
		await vi.waitFor(() =>
			expect(document.querySelector('[data-testid="composer-tags"] [data-tag="t1"]')).not.toBeNull()
		);

		box().value = 'the fee service is down';
		box().dispatchEvent(new Event('input', { bubbles: true }));
		await screen.getByRole('button', { name: 'Post' }).click();

		await vi.waitFor(() =>
			expect(acts.calls.map((call) => call.name)).toEqual(['postMessage', 'tagCard'])
		);
		// The post first, then the label on the id it came back with.
		expect(acts.calls[1].args.slice(0, 4)).toEqual(['message', 'new', 't1', true]);
	});

	it('forgets the choice once the post has gone', async () => {
		const { screen } = withTags();

		await screen.getByTestId('tag-add').click();
		(document.querySelector('[data-pick="t1"]') as HTMLElement).click();
		box().value = 'something';
		box().dispatchEvent(new Event('input', { bubbles: true }));
		await screen.getByRole('button', { name: 'Post' }).click();

		await vi.waitFor(() =>
			expect(document.querySelector('[data-testid="composer-tags"] [data-tag]')).toBeNull()
		);
	});

	it('takes a chosen word off again before anything is sent', async () => {
		const { acts, screen } = withTags();

		await screen.getByTestId('tag-add').click();
		(document.querySelector('[data-pick="t2"]') as HTMLElement).click();
		await vi.waitFor(() =>
			expect(document.querySelector('[data-testid="composer-tags"] [data-tag="t2"]')).not.toBeNull()
		);
		(
			document.querySelector('[data-testid="composer-tags"] [data-tag="t2"]') as HTMLElement
		).click();

		await vi.waitFor(() =>
			expect(document.querySelector('[data-testid="composer-tags"] [data-tag]')).toBeNull()
		);
		expect(acts.calls).toEqual([]);
	});

	it('decides a new word, in the colour picked for it', async () => {
		const { acts, screen } = withTags();

		await screen.getByTestId('tag-add').click();
		(document.querySelector('[data-new-colour="rose"]') as HTMLElement).click();
		const typed = document.querySelector('[data-testid="tag-new"]') as HTMLInputElement;
		typed.value = 'needs design';
		typed.dispatchEvent(new Event('input', { bubbles: true }));
		typed.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

		await vi.waitFor(() => expect(acts.calls[0]?.name).toBe('defineTag'));
		expect(acts.calls[0].args).toEqual(['agent-dashboard', 'needs design', 'rose']);
	});

	it('offers nothing to tag until a project is chosen', async () => {
		const acts = fakeActions();
		render(Composer, {
			project: null,
			projects: [aProject({ id: 'p1', slug: 'agent-dashboard', name: 'Agent Dashboard' })],
			tags: [aTag({ id: 't1', projectId: 'p1' })],
			actions: acts.actions
		});

		expect(
			document.querySelector('[data-testid="composer-tags"] [data-testid="tag-add"]')
		).toBeNull();
	});
});
