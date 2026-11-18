/**
 * `GET|POST /api/projects/[reference]/tags` (migration 039).
 *
 * A project's own vocabulary: read it, or decide another word for it. The work
 * is in `$http/owner`.
 */
import { defineTagHandler, listTagsHandler } from '$http/owner';
import type { RequestHandler } from './$types';

const list = listTagsHandler();
const define = defineTagHandler();

export const GET: RequestHandler = (event) => list(event);
export const POST: RequestHandler = (event) => define(event);
