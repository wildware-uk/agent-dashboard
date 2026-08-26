/**
 * `POST /api/tasks` — the owner creates a task (design §7).
 *
 * The browser's half of the control plane: agents claim and complete over MCP,
 * the owner puts the work there. Optionally targeted at one agent, which is the
 * one place an agent id is an argument rather than an identity — and the session
 * cookie is what makes that safe. The work is in `$http/owner`.
 */
import { createTaskHandler } from '$http/owner';
import type { RequestHandler } from './$types';

const create = createTaskHandler();

export const POST: RequestHandler = (event) => create(event);
