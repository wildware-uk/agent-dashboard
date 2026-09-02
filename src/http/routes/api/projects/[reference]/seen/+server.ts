/**
 * `POST /api/projects/[reference]/seen` — the owner opened this project.
 *
 * What clears the sidebar's "new" badge. A route of its own rather than a field
 * on the project patch: reading a project is not editing it, and the two must
 * not share an `updated_at`.
 */
import { markProjectSeenHandler } from '$http/owner';
import type { RequestHandler } from './$types';

const seen = markProjectSeenHandler();

export const POST: RequestHandler = (event) => seen(event);
