/**
 * `list_apps` (migration 041) — what is already shipped here.
 *
 * Cheap, and named in `register_app`'s description as the thing to do first, for
 * the reason `list_embed_types` is: registering a near-copy of an app that
 * already exists is the obvious way for this feature to go wrong. It also
 * answers the question an agent actually has — *is this one mine to replace?*
 */
import { listAppSummaries } from '$domain';
import { ok } from '../results';
import type { McpTool } from './types';

const inputSchema = {};

export const listAppsTool: McpTool<typeof inputSchema> = {
	name: 'list_apps',
	config: {
		title: 'List apps',
		description: [
			'List the interfaces registered on this dashboard, so you can show one that already',
			'exists rather than writing a near-copy of it. Call this before register_app.',
			'',
			'Takes no arguments.',
			'',
			'Returns { apps: [{ uri, name, description, url, bytes, csp, mine, updated_at }], count }.',
			"`url` is set for an app that frames a service's own page rather than a document this",
			'dashboard serves.',
			'`mine` is whether you registered it — an app that is not yours cannot be replaced, so',
			'register your own under a different ui:// URI if one is nearly but not quite right.',
			'Show one with apps: [{ app: "<uri>", data: { ... } }] on post_update or post_message.'
		].join('\n'),
		inputSchema,
		annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
	},

	run: ({ ctx, agent }) => {
		const apps = listAppSummaries(ctx, agent.id);

		return ok(
			apps.length === 0
				? 'No apps are registered here yet. register_app ships one.'
				: `${apps.length} app(s) registered.`,
			{
				apps: apps.map((app) => ({
					uri: app.uri,
					name: app.name,
					description: app.description,
					url: app.url,
					bytes: app.bytes,
					csp: app.csp,
					mine: app.mine,
					updated_at: app.updatedAt
				})),
				count: apps.length
			}
		);
	}
};
