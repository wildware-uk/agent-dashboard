/**
 * `POST /api/projects` — create a project from the browser (design §7).
 *
 * Idempotent on slug, like the MCP tool: re-posting the form yields the existing
 * project with `created: false` and a 200 rather than a duplicate or an error.
 * The work is in `$http/owner`.
 */
import { createProjectHandler } from '$http/owner';
import type { RequestHandler } from './$types';

const create = createProjectHandler();

export const POST: RequestHandler = (event) => create(event);
