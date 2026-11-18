/** `GET /api/summary` — the dashboard in one small read, for the iOS app's widgets. */
import { summaryHandler } from '$http/owner';
import type { RequestHandler } from './$types';

const summary = summaryHandler();

export const GET: RequestHandler = (event) => summary(event);
