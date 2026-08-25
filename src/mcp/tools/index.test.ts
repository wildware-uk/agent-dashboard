import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TOOLS, TOOL_NAMES } from './index';
import type { AnyMcpTool } from './types';

const tools: readonly AnyMcpTool[] = TOOLS;

/**
 * Words that would let one agent act as another if any of them were ever an
 * argument. Identity comes from the bearer token and from nowhere else
 * (design §5), and this is the assertion that keeps it that way.
 */
const IDENTITY_WORDS = ['agent', 'author', 'behalf', 'as_user', 'token', 'session'];

describe('the tool set', () => {
	it('is the three tools this slice owns, in the order the design lists them', () => {
		expect(TOOL_NAMES).toEqual(['create_project', 'list_projects', 'post_update']);
	});

	it('names every tool in snake_case, as the design writes them', () => {
		for (const tool of tools) {
			expect(tool.name, tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
		}
	});
});

describe('no tool takes an agent identifier', () => {
	it('has no argument that could name a different agent', () => {
		for (const tool of tools) {
			for (const argument of Object.keys(tool.config.inputSchema)) {
				for (const word of IDENTITY_WORDS) {
					expect(
						argument.toLowerCase().includes(word),
						`${tool.name} takes an argument called ${argument}`
					).toBe(false);
				}
			}
		}
	});

	it('drops an agent_id passed anyway: it is in no schema, so it cannot reach a handler', () => {
		for (const tool of tools) {
			// What the SDK does with an argument it was not told about: strip it.
			const stripped = z.object(tool.config.inputSchema).partial().parse({
				agent_id: 'someone-else'
			});
			expect(stripped, tool.name).not.toHaveProperty('agent_id');

			// And the schema really has no such field, rather than a lenient object
			// hiding one.
			const strict = z.strictObject(tool.config.inputSchema).safeParse({ agent_id: 'x' });
			expect(strict.success, tool.name).toBe(false);
		}
	});
});

describe('tool descriptions are the API documentation', () => {
	it('gives every tool a title and a description with room to explain itself', () => {
		for (const tool of tools) {
			expect(tool.config.title, tool.name).toBeTruthy();
			expect(tool.config.description.length, tool.name).toBeGreaterThan(120);
		}
	});

	it('names every argument in the tool description, and says what it accepts', () => {
		for (const tool of tools) {
			for (const argument of Object.keys(tool.config.inputSchema)) {
				expect(tool.config.description, `${tool.name}.${argument}`).toContain(argument);
			}
		}
	});

	it('describes every argument in the schema too, so a client can show it inline', () => {
		for (const tool of tools) {
			for (const [argument, schema] of Object.entries(tool.config.inputSchema)) {
				expect(schema.description, `${tool.name}.${argument}`).toBeTruthy();
			}
		}
	});

	it('tells an agent that identity comes from its token, once, where it matters', () => {
		const postUpdate = tools.find((tool) => tool.name === 'post_update')!;

		expect(postUpdate.config.description.toLowerCase()).toContain('token');
	});
});

describe('tool argument schemas', () => {
	it('asks only for what a caller cannot avoid', () => {
		const required = Object.fromEntries(
			tools.map((tool) => [
				tool.name,
				Object.entries(tool.config.inputSchema)
					.filter(([, schema]) => !schema.safeParse(undefined).success)
					.map(([argument]) => argument)
			])
		);

		expect(required).toEqual({
			create_project: ['name'],
			list_projects: [],
			post_update: ['project', 'body']
		});
	});
});
