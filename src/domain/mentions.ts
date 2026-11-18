/**
 * `@name`: a message meant for some agents rather than all of them.
 *
 * The owner: "mentioning an agent with @agent-name will notify them only;
 * otherwise all agents will be notified." A message that names at least one
 * agent reaches only those agents; one that names none reaches everybody, as
 * every message did before (migration 044).
 *
 * Matched against agent names, case-insensitively, rather than parsed as a word
 * shape, because names are free text the owner typed. Names are not unique, so
 * `@build-bot` names every agent called that. A name that matches no agent is
 * just text, and so is anything in code, where `@Component` is not anybody.
 */
import { listAgents, setMessageMentions } from '$db';
import type { DomainContext } from './context';

/** Fenced blocks (closed or running to the end) and inline code spans. */
const CODE = /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`/g;

/** Which of these names the body mentions, compared case-insensitively. */
export function mentionedNames(body: string, names: Iterable<string>): Set<string> {
	const prose = body.replace(CODE, ' ');
	const found = new Set<string>();

	for (const name of names) {
		if (name.trim() === '') continue;
		const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		// Not glued to a word before it, so an email address is not a mention,
		// and not running on into a longer name after it.
		const pattern = new RegExp(`(?<![\\w@])@${escaped}(?![\\w-])`, 'iu');
		if (pattern.test(prose)) found.add(name.toLowerCase());
	}

	return found;
}

/** Every live agent this body names, by id. */
export function mentionedAgentIds(ctx: DomainContext, body: string): string[] {
	if (!body.includes('@')) return [];

	const agents = listAgents(ctx.db);
	const names = mentionedNames(body, new Set(agents.map((agent) => agent.name)));
	return agents.filter((agent) => names.has(agent.name.toLowerCase())).map((agent) => agent.id);
}

/** Store who this message names, replacing what it named before an edit. */
export function recordMentions(ctx: DomainContext, messageId: string, body: string): void {
	setMessageMentions(ctx.db, messageId, mentionedAgentIds(ctx, body));
}
