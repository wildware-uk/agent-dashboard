/**
 * The owner's half of an owner request (design §5, §7): answering one, and
 * dismissing one.
 *
 * Two endpoints, the same three rules the rest of `../owner/` keeps — the domain
 * does the work, the write publishes so every open tab and every parked agent
 * follows, and the session is checked here as well as in the hook, through the
 * wrapper imported from `./actions.ts` rather than written again.
 *
 * **The answer is not validated here.** It is checked in `$domain`, against the
 * request that asked for it, and this file deliberately does nothing more than
 * pull `value` off the body and hand it over untouched — including when it is a
 * boolean or an array. Anything else would be a second, weaker copy of the rule
 * an agent is trusting (`src/domain/requests.ts`), and the endpoint below is
 * exactly what a hostile client would post to.
 */
import { answerRequest, cancelRequest, invalid } from '$domain';
import {
	ownerAction,
	readOwnerJson,
	type OwnerActionEvent,
	type OwnerHandler,
	type OwnerHandlerOptions
} from './actions';

export type { OwnerActionEvent, OwnerHandler };

/**
 * `POST /api/requests/[id]/answer` — the owner answers a pending request.
 *
 * 200 with the settled request. A second answer to the same request is a 409:
 * the row left `pending` when the first one landed, and telling the second
 * clicker "already answered" is the truth rather than a silent overwrite of what
 * the agent has already acted on.
 */
export function answerRequestHandler(options: OwnerHandlerOptions = {}): OwnerHandler {
	return ownerAction(options, async (event, ctx) => {
		const body = await readOwnerJson(event.request);
		if (!('value' in body)) throw invalid('an answer must carry a value');

		const request = answerRequest(ctx, {
			requestId: event.params.id ?? '',
			// Untouched, whatever it is: `$domain` is the only thing that decides
			// whether this value is allowed.
			value: body.value
		});
		return { status: 200, body: { request } };
	});
}

/**
 * `DELETE /api/requests/[id]` — the owner dismisses without answering.
 *
 * The agent hears `cancelled`, which its tool description tells it is not
 * permission (design §5).
 */
export function dismissRequestHandler(options: OwnerHandlerOptions = {}): OwnerHandler {
	return ownerAction(options, (event, ctx) =>
		Promise.resolve({
			status: 200,
			body: { request: cancelRequest(ctx, event.params.id ?? '') }
		})
	);
}
