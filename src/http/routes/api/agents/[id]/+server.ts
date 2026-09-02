/**
 * `PATCH /api/agents/[id]` — rename one agent (design §7).
 *
 * The only thing the owner may change about an agent: its token is its
 * identity, and the name is the part they author. Minting and revoking stay on
 * the CLI, where they belong — one needs a secret shown once, and the other is
 * not something to do by accident from a browser.
 */
import { renameAgentHandler } from '$http/owner';
import type { RequestHandler } from './$types';

const rename = renameAgentHandler();

export const PATCH: RequestHandler = (event) => rename(event);
