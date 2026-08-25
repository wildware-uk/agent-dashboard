/**
 * One project's timeline. The same shell as `/`, scoped to a slug.
 *
 * An unknown slug becomes a 404 rather than silently widening to every project:
 * see `loadDashboard`.
 */
import { loadDashboard } from '../../dashboard';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ params }) => loadDashboard(params.slug);
