/**
 * An app that is a page somewhere else, rather than a document we hold.
 *
 * The owner: "what about the actual downstream service that must render the UI?
 * For example I have a fix dashboard, I'd like the agent to be able to include
 * an iframe directly from that, with live results from a query."
 *
 * That is a different shape from migration 041 and a better fit for a service
 * that already exists. A self-contained document has to be *given* its data — by
 * the agent, through `set_app_data` — and it runs on an opaque origin, so it
 * cannot use the service's own session. A page served by the service itself runs
 * on **its own** origin: its cookies work, its queries are same-origin, and
 * "live results" means what it already means over there.
 *
 * So an app is now one of two things, and exactly one:
 *
 * - `html` — a document this deployment serves and sandboxes (migration 041);
 * - `url`  — an https page the dashboard frames directly.
 *
 * A column rather than a second table: everything else about an app is the same
 * either way, and a showing does not care which it is drawing.
 *
 * ## The sandbox differs, and that is the point
 *
 * An `html` app is framed with `allow-scripts` and no `allow-same-origin`,
 * because it is markup an agent wrote and it must not have an origin worth
 * having. A `url` app is framed with `allow-same-origin` as well — and that is
 * *safe here*, because "same origin" means the service's own origin, not this
 * dashboard's. The page is cross-origin from the dashboard either way and can no
 * more read this session than any other third-party frame can.
 */
export const sql = `
-- The page to frame, for an app that lives somewhere else. NULL for the ones
-- that are a document we hold; exactly one of the two is set, which the domain
-- enforces because SQLite's CHECK cannot be widened later without a rebuild.
ALTER TABLE apps ADD COLUMN url TEXT;
`;
