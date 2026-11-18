import { describe, expect, it } from 'vitest';
import { createProject, fieldsOn, postUpdate, setField } from '$domain';
import { mcpHarness } from '../testing';
import { getCardFieldsTool, setCardFieldTool } from './card-fields';

/**
 * `set_card_field` and `get_card_fields` (migration 040).
 *
 * The owner: "allow agents to set metadata on cards, for example, branch name,
 * PR link, anything they like."
 */
function aCard(mcp: ReturnType<typeof mcpHarness>) {
	const { project } = createProject(mcp.h, { name: 'Dashboard' });
	return postUpdate(mcp.h, {
		project: project.slug,
		agentId: mcp.deps.agent.id,
		body: 'rewriting the fee curve'
	});
}

type Fields = { fields: { name: string; value: string; author: string }[]; set?: boolean };

describe('noting something on a card', () => {
	it('records the value against the agent that set it', async () => {
		const mcp = mcpHarness();
		const update = aCard(mcp);

		const result = await setCardFieldTool.run(mcp.deps, {
			update_id: update.id,
			name: 'branch',
			value: 'fix/fees'
		});

		expect(result.isError).toBeFalsy();
		const body = result.structuredContent as Fields;
		expect(body.set).toBe(true);
		expect(body.fields[0]).toMatchObject({
			name: 'branch',
			value: 'fix/fees',
			author: `agent:${mcp.deps.agent.id}`
		});
	});

	it('hands back every field, so nothing has to be read back', async () => {
		const mcp = mcpHarness();
		const update = aCard(mcp);
		await setCardFieldTool.run(mcp.deps, { update_id: update.id, name: 'branch', value: 'a' });

		const result = await setCardFieldTool.run(mcp.deps, {
			update_id: update.id,
			name: 'PR link',
			value: 'https://example.test/pr/1'
		});

		expect((result.structuredContent as Fields).fields.map((f) => f.name)).toEqual([
			'branch',
			'PR link'
		]);
	});

	it('corrects what the owner wrote, and says who touched it last', async () => {
		const mcp = mcpHarness();
		const update = aCard(mcp);
		setField(mcp.h, {
			card: { kind: 'update', id: update.id },
			name: 'branch',
			value: 'theirs',
			actor: { kind: 'human' }
		});

		await setCardFieldTool.run(mcp.deps, { update_id: update.id, name: 'branch', value: 'mine' });

		expect(fieldsOn(mcp.h, { kind: 'update', id: update.id })[0]).toMatchObject({
			value: 'mine',
			author: `agent:${mcp.deps.agent.id}`
		});
	});

	it('takes a field off with a null value', async () => {
		const mcp = mcpHarness();
		const update = aCard(mcp);
		await setCardFieldTool.run(mcp.deps, { update_id: update.id, name: 'branch', value: 'a' });

		const result = await setCardFieldTool.run(mcp.deps, {
			update_id: update.id,
			name: 'branch',
			value: null
		});

		expect((result.structuredContent as Fields).set).toBe(false);
		expect(fieldsOn(mcp.h, { kind: 'update', id: update.id })).toEqual([]);
	});

	it('refuses no card, two cards, and a card that is not there', async () => {
		const mcp = mcpHarness();
		const update = aCard(mcp);

		const none = await setCardFieldTool.run(mcp.deps, { name: 'branch', value: 'a' });
		const both = await setCardFieldTool.run(mcp.deps, {
			update_id: update.id,
			message_id: update.id,
			name: 'branch',
			value: 'a'
		});
		const gone = await setCardFieldTool.run(mcp.deps, {
			update_id: 'nope',
			name: 'branch',
			value: 'a'
		});

		expect(none.structuredContent).toMatchObject({ error: 'invalid_argument' });
		expect(both.structuredContent).toMatchObject({ error: 'invalid_argument' });
		expect(gone.structuredContent).toMatchObject({ error: 'not_found' });
	});
});

describe('reading what is noted', () => {
	it('lists the fields, whoever set them', async () => {
		const mcp = mcpHarness();
		const update = aCard(mcp);
		setField(mcp.h, {
			card: { kind: 'update', id: update.id },
			name: 'branch',
			value: 'fix/fees',
			actor: { kind: 'human' }
		});

		const result = await getCardFieldsTool.run(mcp.deps, { update_id: update.id });

		const body = result.structuredContent as Fields & { count: number };
		expect(body.count).toBe(1);
		expect(body.fields[0]).toMatchObject({ name: 'branch', author: 'human' });
	});

	it('says plainly when nothing has been noted', async () => {
		const mcp = mcpHarness();
		const update = aCard(mcp);

		const result = await getCardFieldsTool.run(mcp.deps, { update_id: update.id });

		expect((result.structuredContent as { count: number }).count).toBe(0);
		expect(result.content?.[0]).toMatchObject({ text: expect.stringContaining('Nothing noted') });
	});
});
