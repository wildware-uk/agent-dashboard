/**
 * What an app saves for itself (migration 041).
 *
 * An app runs in a frame with no same-origin privileges, which means no
 * `localStorage` worth having: the open tab, the half-filled form, the sort
 * order would all be lost the moment the card re-rendered. So the app sends
 * `ui/notifications/state-changed` and the bridge posts it here.
 *
 * It is the owner's own write, not the agent's, and the session is what says so.
 * An agent pushing fresh data with `set_app_data` writes the other column, which
 * is exactly why they are two columns: neither one can wipe out the other.
 */
import { saveAppState } from '$domain';
import { invalid } from '$domain/errors';
import { ownerAction, readOwnerJson, type OwnerHandler, type OwnerHandlerOptions } from './actions';

/**
 * `POST /api/apps/[view]/state` — keep this showing's own state.
 *
 * `{ state }`, an object, or `null` to forget it. Deliberately not announced on
 * the bus: redrawing every open tab because somebody opened a section would be
 * worse than two tabs disagreeing about which section is open.
 */
export function saveAppStateHandler(options: OwnerHandlerOptions = {}): OwnerHandler {
	return ownerAction(options, async (event, ctx) => {
		const body = (await readOwnerJson(event.request).catch(() => ({}))) as { state?: unknown };
		if (body.state !== null && (typeof body.state !== 'object' || Array.isArray(body.state))) {
			throw invalid('state must be an object, or null to forget it');
		}

		const view = saveAppState(ctx, event.params.view ?? '', body.state);
		return { status: 200, body: { view_id: view.id, state: view.state } };
	});
}
