import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createProject, listAgents, registerSession } from '$domain';
import { mcpHarness } from '../testing';
import { TOOLS, TOOL_NAMES } from './index';
import type { AnyMcpTool, McpTool } from './types';

const tools: readonly AnyMcpTool[] = TOOLS;

/**
 * Words that would let one agent act as another if any of them were ever an
 * argument. Identity comes from the bearer token and from nowhere else
 * (design §5), and this is the assertion that keeps it that way.
 *
 * `session` is deliberately not on the list: design §5 gives `heartbeat` and
 * `end_session` a `session_id`, and a session id is a handle on a run rather
 * than a claim about who is calling. What keeps that safe is not the absence of
 * the argument but the domain's belongs-to check — every session-taking tool is
 * asserted below to refuse a session that belongs to another agent, which is a
 * stronger guarantee than a naming rule could give.
 */
const IDENTITY_WORDS = ['agent', 'author', 'behalf', 'as_user', 'token'];

describe('the tool set', () => {
	it('is the tools built so far, in the order the design lists them', () => {
		expect(TOOL_NAMES).toEqual([
			'create_project',
			'list_projects',
			'set_project_theme',
			'post_update',
			'edit_update',
			'create_upload',
			'attach_media',
			'register_session',
			'heartbeat',
			'end_session',
			'list_tasks',
			'create_task',
			'claim_task',
			'complete_task',
			'get_messages',
			'post_message',
			'delete_message',
			'react',
			'acknowledge',
			'request_input',
			'await_request'
		]);
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
			set_project_theme: ['project'],
			post_update: ['project', 'body'],
			edit_update: ['update_id'],
			create_upload: ['filename', 'mime', 'bytes'],
			attach_media: ['update_id', 'media_ids'],
			register_session: [],
			heartbeat: ['session_id'],
			end_session: ['session_id'],
			list_tasks: [],
			create_task: ['project', 'title'],
			claim_task: ['task_id'],
			complete_task: ['task_id', 'result'],
			get_messages: [],
			post_message: ['body'],
			delete_message: ['message_id'],
			react: ['message_id', 'emoji'],
			acknowledge: ['state'],
			request_input: ['kind', 'question'],
			await_request: ['request_id']
		});
	});
});

describe('a session id is a handle, not an identity', () => {
	/**
	 * Every tool that takes somebody's session id, and whatever else it needs to
	 * get as far as looking at that id. `post_update` joined them in issue #21,
	 * which is exactly why the coverage check below exists.
	 */
	const sessionTools = {
		post_update: { project: 'agent-dashboard', body: 'not my run' },
		heartbeat: {},
		end_session: {}
	} as const;

	it('refuses a session that belongs to another agent', () => {
		const mcp = mcpHarness({ name: 'scout' });
		createProject(mcp.h, { name: 'Agent Dashboard' });
		const { session } = registerSession(mcp.h, { agentId: mcp.deps.agent.id });
		const intruderId = mcp.mint('intruder').agentId;
		const intruder = listAgents(mcp.h).find((agent) => agent.id === intruderId)!;

		for (const [name, rest] of Object.entries(sessionTools)) {
			const tool = TOOLS.find((candidate) => candidate.name === name) as unknown as McpTool<{
				session_id: z.ZodType;
			}>;

			const result = tool.run({ ctx: mcp.h, agent: intruder }, {
				...rest,
				session_id: session.id
			} as unknown as { session_id: string });

			// The code matters as much as the refusal: an agent is told the session
			// is not its own, not that something vague went wrong.
			expect(result, name).toMatchObject({
				isError: true,
				structuredContent: { error: 'invalid_argument' }
			});
		}
	});

	it('covers every tool that takes one, so a new one cannot skip the check', () => {
		const taking = TOOLS.filter((tool) => 'session_id' in tool.config.inputSchema).map(
			(tool) => tool.name
		);

		expect(taking).toEqual(Object.keys(sessionTools));
	});
});
