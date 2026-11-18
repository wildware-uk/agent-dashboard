/**
 * `list_embed_types` (migration 027) — what the dashboard already knows how to draw.
 *
 * Registering a near-copy of a look that already exists is the obvious way for
 * this feature to go wrong, so this is cheap and is named in
 * `register_embed_type`'s description as the thing to do first. It also answers
 * the question an agent actually has — *which values does this look want?* — by
 * listing the `{{placeholders}}` each one reads, which is a fact about the spec
 * rather than documentation somebody has to keep in step with it.
 */
import { listEmbedTypeViews, type EmbedSpec } from '$domain';
import { ok } from '../results';
import type { McpTool } from './types';

const inputSchema = {};

/** Every `{{name}}` a spec mentions, in the order they are first drawn. */
export function placeholdersIn(spec: EmbedSpec): string[] {
	const found = new Set<string>();

	const scan = (value: unknown) => {
		if (typeof value === 'string') {
			for (const match of value.matchAll(/\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g)) found.add(match[1]);
			return;
		}
		if (Array.isArray(value)) {
			for (const entry of value) scan(entry);
			return;
		}
		if (value && typeof value === 'object') {
			for (const entry of Object.values(value)) scan(entry);
		}
	};

	scan(spec.chrome);
	scan(spec.blocks);

	return [...found];
}

export const listEmbedTypesTool: McpTool<typeof inputSchema> = {
	name: 'list_embed_types',
	config: {
		title: 'List embed looks',
		description: [
			'List the looks an embed can be drawn in, so you can reuse one instead of registering a',
			'near-copy of it. Call this before register_embed_type.',
			'',
			'Five ship with the dashboard: slack-message, github-comment, jira-issue,',
			'confluence-page and linked-page. Those are marked built_in and cannot be redefined;',
			'register your own under a different slug if one is nearly but not quite right.',
			'',
			'Takes no arguments.',
			'',
			'Returns { types: [{ slug, name, built_in, blocks, fields }], count }. `fields` is the',
			'list of values that look reads — pass exactly those as `data` when you post one, e.g.',
			'{ "username": "sam", "channel": "#deploys", "text": "it is green" }. `blocks` is what',
			'it draws, in order.'
		].join('\n'),
		inputSchema,
		annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
	},

	run: ({ ctx }) => {
		const types = listEmbedTypeViews(ctx).map((type) => ({
			slug: type.slug,
			name: type.name,
			built_in: type.builtIn,
			blocks: type.spec.blocks.map((block) => block.type),
			fields: placeholdersIn(type.spec)
		}));

		return ok(types.length === 1 ? '1 embed look.' : `${types.length} embed looks.`, {
			types,
			count: types.length
		});
	}
};
