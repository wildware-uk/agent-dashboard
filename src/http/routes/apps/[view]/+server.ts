/**
 * `GET /apps/[view]` — one app's document, for the frame that renders it.
 *
 * The headers are the containment and they are documented at
 * `src/http/apps/serve.ts`. This file is the mount point.
 */
import { createAppHandler } from '$http/apps';
import type { RequestHandler } from './$types';

const app = createAppHandler();

export const GET: RequestHandler = (event) => app(event);
