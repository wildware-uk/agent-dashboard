/**
 * The dashboard root: every project's updates in one timeline.
 *
 * The work is in `./dashboard.ts`, which `/projects/[slug]` shares.
 */
import { loadDashboard } from './dashboard';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = () => loadDashboard(null);
