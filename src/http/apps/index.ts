/**
 * Serving the documents apps are (migration 041).
 *
 * One route, `GET /apps/:view`, and the policy it answers with. Kept apart from
 * `$http/owner` because it is the only route on this deployment that returns
 * HTML somebody else wrote, and that deserves a file of its own to read.
 */
export { createAppHandler, policyFor, type AppHandler, type AppHandlerOptions } from './serve';
