/**
 * The Claude Code plugin (`plugins/agent-dashboard/`), as executable expectations.
 *
 * The plugin is the only part of this product that runs on somebody else's
 * machine with nothing installed beside it, and every way it breaks there is
 * silent: a placeholder Claude Code does not interpolate becomes a literal
 * `${user_config...}` in an Authorization header and reads as a revoked token; a
 * committed bundle that drifts from `src/channel/` announces work the tools
 * cannot find; a renamed tool leaves a skill confidently instructing an agent to
 * call something that no longer exists.
 *
 * None of that is caught by a test of the server, so it is asserted here.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TOOL_NAMES } from '$mcp';
import { CHANNEL_NAME, INSTRUCTIONS } from '$channel';

const ROOT = resolve(import.meta.dirname, '..');
const PLUGIN = resolve(ROOT, 'plugins/agent-dashboard');

const read = (path: string) => readFileSync(resolve(ROOT, path), 'utf8');
const readJson = (path: string) => JSON.parse(read(path));
const exists = (path: string) => {
	try {
		return statSync(resolve(ROOT, path)).isFile();
	} catch {
		return false;
	}
};

const marketplace = readJson('.claude-plugin/marketplace.json');
const manifest = readJson('plugins/agent-dashboard/.claude-plugin/plugin.json');
const mcp = readJson('plugins/agent-dashboard/.mcp.json');
const hooks = readJson('plugins/agent-dashboard/hooks/hooks.json');

const skillDirs = readdirSync(resolve(PLUGIN, 'skills'));
const skills = Object.fromEntries(
	skillDirs.map((dir) => [dir, read(`plugins/agent-dashboard/skills/${dir}/SKILL.md`)])
);
const commandFiles = readdirSync(resolve(PLUGIN, 'commands')).filter((f) => f.endsWith('.md'));
const commands = Object.fromEntries(
	commandFiles.map((file) => [file, read(`plugins/agent-dashboard/commands/${file}`)])
);

/** The frontmatter block of a markdown file, as raw text. */
function frontmatter(source: string): string {
	const match = /^---\n([\s\S]*?)\n---/.exec(source);
	return match ? match[1] : '';
}

describe('marketplace.json', () => {
	it('has the three fields a marketplace cannot be added without', () => {
		expect(marketplace.name).toBe('agent-dashboard');
		expect(marketplace.owner?.name).toBeTruthy();
		expect(Array.isArray(marketplace.plugins)).toBe(true);
	});

	it('points at a plugin directory that is really there', () => {
		for (const plugin of marketplace.plugins) {
			expect(typeof plugin.source, plugin.name).toBe('string');
			expect(plugin.source.startsWith('./'), plugin.source).toBe(true);
			expect(exists(`${plugin.source}/.claude-plugin/plugin.json`), plugin.source).toBe(true);
		}
	});

	it('does not advertise a version the plugin itself disagrees with', () => {
		const entry = marketplace.plugins.find((p: { name: string }) => p.name === manifest.name);
		expect(entry).toBeDefined();
		expect(entry.version).toBe(manifest.version);
	});
});

describe('plugin.json', () => {
	it('is named for the directory it lives in, which is what /plugin install takes', () => {
		expect(manifest.name).toBe('agent-dashboard');
	});

	it('asks for the two values without which nothing authenticates', () => {
		expect(manifest.userConfig.dashboard_url.required).toBe(true);
		expect(manifest.userConfig.agent_token.required).toBe(true);
	});

	it('marks the token sensitive, so it is not echoed back into a transcript', () => {
		expect(manifest.userConfig.agent_token.sensitive).toBe(true);
	});

	it('makes the channel subscription explicit, because the bridge refuses to infer one', () => {
		// `src/channel/bridge.ts` exits rather than defaulting: a scope nobody
		// chose is a scope that accumulates out of the agent's own history.
		expect(manifest.userConfig.projects.required).toBe(true);
		expect(manifest.userConfig.projects.description).toContain('*');
	});
});

describe('.mcp.json', () => {
	const remote = mcp.mcpServers['agent-dashboard'];
	const channel = mcp.mcpServers['agent-dashboard-channel'];

	it('registers the channel under the name its own instructions tell agents to look for', () => {
		// The `source` attribute on a <channel> tag is the config entry's name, and
		// INSTRUCTIONS names it verbatim. Rename the entry here and every agent is
		// told to watch for a tag that never arrives.
		expect(INSTRUCTIONS).toContain('agent-dashboard-channel');
		expect(channel).toBeDefined();
		expect(remote).toBeDefined();
	});

	it('appends /mcp to the origin the user configures, so they never type a path', () => {
		expect(remote.type).toBe('http');
		expect(remote.url).toBe('${user_config.dashboard_url}/mcp');
		expect(channel.env.AGENT_DASHBOARD_URL).toBe('${user_config.dashboard_url}');
	});

	it('sends the token as a bearer credential and nowhere else', () => {
		expect(remote.headers.Authorization).toBe('Bearer ${user_config.agent_token}');
		expect(JSON.stringify(remote.url)).not.toContain('agent_token');
	});

	it('gives both servers the same identity, or the channel announces work the tools cannot find', () => {
		expect(channel.env.AGENT_DASHBOARD_TOKEN).toBe('${user_config.agent_token}');
	});

	it('spawns the bundled bridge by plugin root, not by a path baked in at build time', () => {
		expect(channel.command).toBe('node');
		expect(channel.args).toEqual(['${CLAUDE_PLUGIN_ROOT}/bin/channel.mjs']);
		expect(exists('plugins/agent-dashboard/bin/channel.mjs')).toBe(true);
	});
});

describe.each(['channel', 'monitor'])('the committed %s bundle', (name) => {
	const bundle = read(`plugins/agent-dashboard/bin/${name}.mjs`);

	it('is self-contained, because a plugin is cloned and never npm-installed', () => {
		// A bare specifier here resolves to nothing beside the plugin directory and
		// the channel dies at spawn with a module-not-found the user cannot act on.
		const bareImports = [...bundle.matchAll(/^\s*import[^'"\n]*from\s*['"]([^'"./][^'"]*)['"]/gm)]
			.map((match) => match[1])
			.filter((specifier) => !specifier.startsWith('node:'));
		expect(bareImports).toEqual([]);
	});

	it('is executable as a program', () => {
		expect(bundle.startsWith('#!/usr/bin/env node')).toBe(true);
	});

	it('was built from the current src/channel, not left behind by an older one', () => {
		// The wording both bundles share, so a reworded contract fails here rather
		// than shipping stale advice to every installed agent.
		expect(bundle).toContain('Waiting for you on the dashboard');
		expect(bundle).toContain('AGENT_DASHBOARD_PROJECTS');
		if (name === 'channel') expect(bundle).toContain(CHANNEL_NAME);
	});
});

/**
 * The monitor: the fallback for the sessions that have no channel, which is
 * most of them.
 */
describe('monitors', () => {
	const monitors = readJson('plugins/agent-dashboard/monitors/monitors.json');

	it('runs a bundled script that is really there', () => {
		expect(Array.isArray(monitors)).toBe(true);
		for (const monitor of monitors) {
			expect(monitor.command).toContain('${CLAUDE_PLUGIN_ROOT}');
			expect(exists('plugins/agent-dashboard/bin/monitor.mjs')).toBe(true);
		}
	});

	it('starts on the skill rather than always, so it cannot double up with the channel', () => {
		// Both running means every reply arrives twice, and being interrupted
		// twice for one thing is worse than being interrupted late.
		const [monitor] = monitors;
		expect(monitor.when).toBe('on-skill-invoke:watching-the-dashboard');
		expect(skillDirs).toContain('watching-the-dashboard');
	});

	it('reads no plugin option, because a monitor is given none', () => {
		// `${user_config.*}` in a monitor command is refused outright, and the
		// process gets no CLAUDE_PLUGIN_OPTION_* either. The hook writes a file
		// instead; this is the assertion that stops somebody "simplifying" it back.
		const raw = read('plugins/agent-dashboard/monitors/monitors.json');
		expect(raw).not.toContain('user_config');
	});

	it('is handed its connection by the SessionStart hook', () => {
		const hook = read('plugins/agent-dashboard/scripts/session-start.sh');
		expect(hook).toContain('CLAUDE_PLUGIN_DATA');
		expect(hook).toContain('connection.json');
		// The file holds a bearer token, which is the agent's whole identity.
		expect(hook).toContain('umask 077');
	});
});

describe('hooks', () => {
	it('runs a script that exists and can be executed', () => {
		const [command] = hooks.hooks.SessionStart[0].hooks;
		expect(command.type).toBe('command');
		expect(command.command).toContain('${CLAUDE_PLUGIN_ROOT}');
		const path = command.command.replace('${CLAUDE_PLUGIN_ROOT}', PLUGIN).replace(/"/g, '');
		const stat = statSync(path);
		expect(stat.isFile()).toBe(true);
		expect(stat.mode & 0o111, 'the hook script must be executable').not.toBe(0);
	});
});

describe('skills', () => {
	it('name themselves after their own directory, which is what loads them', () => {
		for (const [dir, source] of Object.entries(skills)) {
			expect(frontmatter(source), dir).toMatch(new RegExp(`^name:\\s*${dir}$`, 'm'));
		}
	});

	it('say when to use them, not only what they are about', () => {
		for (const [dir, source] of Object.entries(skills)) {
			const description = /^description:\s*(.+)$/m.exec(frontmatter(source))?.[1] ?? '';
			expect(description.length, dir).toBeGreaterThan(40);
			expect(description.toLowerCase(), dir).toContain('use ');
		}
	});

	it('document every tool the server actually offers', () => {
		const prose = Object.values(skills).join('\n');
		for (const tool of TOOL_NAMES) {
			expect(prose, `${tool} is offered by the MCP server and named in no skill`).toContain(tool);
		}
	});
});

describe('commands', () => {
	it('each carry the description /help lists them by', () => {
		for (const [file, source] of Object.entries(commands)) {
			expect(frontmatter(source), file).toMatch(/^description:\s*\S/m);
		}
	});

	it('are all the ones the plugin README claims exist', () => {
		const readme = read('plugins/agent-dashboard/README.md');
		for (const file of commandFiles) {
			expect(readme, file).toContain(`/${file.replace(/\.md$/, '')}`);
		}
	});
});

describe('the tool vocabulary in skills and commands', () => {
	/**
	 * snake_case words that are arguments, result fields or config keys rather
	 * than tools. Listed rather than pattern-matched, so that a *renamed* tool
	 * cannot pass by looking like an argument.
	 */
	const NOT_TOOLS = new Set([
		'agent_id',
		'agent_token',
		'answered_at',
		'assign_to_me',
		'dashboard_url',
		'heartbeat_interval_s',
		'interval_s',
		'invalid_argument',
		'logo_media_id',
		'logo_replaces_name',
		'mark_read',
		'media_id',
		'media_ids',
		'message_id',
		'multi_choice',
		'not_found',
		'open_tasks',
		'pending_approvals',
		'poll_after_ms',
		'request_id',
		'session_id',
		'task_id',
		'timeout_s',
		'unread_messages',
		'update_id',
		'upload_url'
	]);

	it('names no tool that does not exist', () => {
		const prose = [...Object.values(skills), ...Object.values(commands)].join('\n');
		const words = new Set(prose.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? []);
		const unknown = [...words].filter((word) => !TOOL_NAMES.includes(word) && !NOT_TOOLS.has(word));
		expect(unknown, 'either a renamed tool or vocabulary to add to NOT_TOOLS').toEqual([]);
	});
});
