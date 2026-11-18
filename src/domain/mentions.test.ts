import { beforeEach, describe, expect, it } from 'vitest';
import { insertAgent, listMessageMentions, revokeAgent } from '$db';
import { harness, type Harness } from '$domain/testing';
import { mentionedNames } from './mentions';
import {
	countUnreadMessages,
	countUnreadMessagesInScope,
	editMessage,
	postMessage,
	readMessages,
	unreadMessagesInScope
} from './messages';
import { createProject } from './projects';
import { postUpdate } from './updates';

let h: Harness;
let scout: string;
let rover: string;
let slug: string;

/** An agent that works in a project, which is what puts it in that audience. */
function workingIn(name: string, project: string): string {
	const agentId = insertAgent(h.db, { name, tokenHash: `hash-${name}-${Math.random()}` }).id;
	postUpdate(h, { project, agentId, body: 'working here' });
	return agentId;
}

function fromOwner(body: string, project = slug) {
	return postMessage(h, { author: { kind: 'human' }, body, project });
}

/** What one agent would be handed, without moving its cursor. */
function inbox(agentId: string): string[] {
	return readMessages(h, { agentId, markRead: false }).messages.map((message) => message.body);
}

beforeEach(() => {
	h = harness();
	slug = createProject(h, { name: 'Dashboard' }).project.slug;
	scout = workingIn('scout', slug);
	rover = workingIn('rover', slug);
});

describe('finding @names in a body', () => {
	const names = ['home-server', 'build', 'build-bot', 'Scout'];

	it('matches whatever case it was typed in', () => {
		expect(mentionedNames('ping @SCOUT and @Home-Server.', names)).toEqual(
			new Set(['scout', 'home-server'])
		);
	});

	it('does not take a longer name for a shorter one', () => {
		expect(mentionedNames('@build-bot, go', names)).toEqual(new Set(['build-bot']));
	});

	it('ignores an email address and anything in code', () => {
		const body = 'mail me@scout.dev\n`@build` and\n```\n@home-server\n```';
		expect(mentionedNames(body, names)).toEqual(new Set());
	});
});

describe('a message that names an agent', () => {
	it('from the owner reaches only that agent', () => {
		const message = fromOwner('@rover can you look at the build?');

		expect(listMessageMentions(h.db, message.id)).toEqual([rover]);
		expect(inbox(rover)).toEqual(['@rover can you look at the build?']);
		expect(inbox(scout)).toEqual([]);
		expect(countUnreadMessages(h, rover)).toBe(1);
		expect(countUnreadMessages(h, scout)).toBe(0);
	});

	it('from another agent reaches only the agent it names', () => {
		const third = workingIn('mender', slug);
		postMessage(h, {
			author: { kind: 'agent', agentId: scout },
			body: 'over to you @rover',
			project: slug
		});

		expect(inbox(rover)).toEqual(['over to you @rover']);
		expect(inbox(third)).toEqual([]);
	});

	it('reaches every agent that shares the name', () => {
		const first = workingIn('build-bot', slug);
		const second = workingIn('build-bot', slug);
		fromOwner('@build-bot rerun it');

		expect(inbox(first)).toEqual(['@build-bot rerun it']);
		expect(inbox(second)).toEqual(['@build-bot rerun it']);
		expect(inbox(scout)).toEqual([]);
	});

	it('reaches an agent outside the projects it works in, and is read like any other', () => {
		const elsewhere = createProject(h, { name: 'Elsewhere' }).project.slug;
		const visitor = workingIn('visitor', elsewhere);
		fromOwner('@visitor a question about this project');

		expect(countUnreadMessages(h, visitor)).toBe(1);
		const live = unreadMessagesInScope(h, visitor, 5, [elsewhere]).map((message) => message.body);
		expect(live).toEqual(['@visitor a question about this project']);

		readMessages(h, { agentId: visitor });
		expect(countUnreadMessages(h, visitor)).toBe(0);
		expect(countUnreadMessagesInScope(h, visitor, [elsewhere])).toBe(0);
	});

	it('is marked read by a read from a cursor, too', () => {
		const elsewhere = createProject(h, { name: 'Elsewhere' }).project.slug;
		const visitor = workingIn('visitor', elsewhere);
		fromOwner('chatter the visitor never sees');
		fromOwner('@visitor this one is yours');

		const page = readMessages(h, { agentId: visitor, since: '0' });
		expect(page.messages.map((message) => message.body)).toEqual(['@visitor this one is yours']);
		expect(countUnreadMessages(h, visitor)).toBe(0);
	});

	it('stays out of another agent`s inbox when read from a cursor too', () => {
		fromOwner('@rover only you');
		fromOwner('everyone');

		const paged = readMessages(h, { agentId: scout, since: '0', markRead: false });
		expect(paged.messages.map((message) => message.body)).toEqual(['everyone']);
	});

	it('is not pulled in from elsewhere when the agent asks for one project', () => {
		const elsewhere = createProject(h, { name: 'Elsewhere' }).project.slug;
		fromOwner('@rover over there', elsewhere);
		fromOwner('here');

		const page = readMessages(h, { agentId: rover, project: slug, markRead: false });
		expect(page.messages.map((message) => message.body)).toEqual(['here']);
	});
});

describe('a message that names nobody', () => {
	it('reaches every agent working in the project, as before', () => {
		fromOwner('morning all');

		expect(inbox(scout)).toEqual(['morning all']);
		expect(inbox(rover)).toEqual(['morning all']);
	});

	it('includes one whose @name matches no agent, or only a revoked one', () => {
		const gone = workingIn('gone', slug);
		revokeAgent(h.db, gone);
		const message = fromOwner('cc @nobody and @gone');

		expect(listMessageMentions(h.db, message.id)).toEqual([]);
		expect(inbox(scout)).toEqual(['cc @nobody and @gone']);
		expect(inbox(rover)).toEqual(['cc @nobody and @gone']);
	});
});

describe('editing a message', () => {
	it('moves it to whoever the new words name', () => {
		const message = fromOwner('@rover take this');
		editMessage(h, { messageId: message.id, by: { kind: 'human' }, body: '@scout take this' });

		expect(inbox(scout)).toEqual(['@scout take this']);
		expect(inbox(rover)).toEqual([]);

		editMessage(h, { messageId: message.id, by: { kind: 'human' }, body: 'anyone, take this' });
		expect(inbox(rover)).toEqual(['anyone, take this']);
	});
});
