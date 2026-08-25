/**
 * `PATCH /api/projects/[reference]` — rename, re-describe, pin, archive (design §7).
 *
 * `reference` is a slug or an id, the same way every MCP tool accepts either
 * (§5), so a link the owner already has keeps working after a rename.
 *
 * Archiving is a status change, never a delete: the project leaves the default
 * sidebar view and its updates stay exactly where they were.
 */
import { patchProjectHandler } from '$http/owner';
import type { RequestHandler } from './$types';

const patch = patchProjectHandler();

export const PATCH: RequestHandler = (event) => patch(event);
