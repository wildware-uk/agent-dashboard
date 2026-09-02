/**
 * Update priority, and per-device notification preferences (design §3, §7).
 *
 * Two columns, one migration, because they exist for each other: a priority
 * nothing filters on is decoration, and a filter with nothing to filter on is a
 * form with one option.
 *
 * **`updates.priority` is separate from `updates.level`, and deliberately so.**
 * Level says what *kind* of thing happened — progress, a success, a warning, a
 * failure — and it is what the card is coloured by. Priority says how much the
 * owner needs to care *now*. They are not the same axis: a routine `error` from
 * a flaky test is low priority, and an `info` saying a migration is about to run
 * against production is high. Collapsing them would mean an agent choosing
 * between colouring the card correctly and reaching a phone at 2am.
 *
 * Defaulted to `medium` rather than made nullable: every existing row is an
 * ordinary update, and "unset" and "middling" would be the same thing for every
 * reader while costing every one of them a null check. There is no `CHECK`
 * because SQLite cannot add one to a live table without a rebuild, and the
 * domain refuses an unknown value at the only door rows come through.
 *
 * **`push_subscriptions.prefs` is JSON and nullable.** Nullable is the whole
 * design of the default: a subscription with no preferences is notified about
 * requests and nothing else, which is exactly what every subscription did before
 * this migration existed. Nobody's phone starts buzzing because the column
 * arrived.
 */
export const sql = `
ALTER TABLE updates ADD COLUMN priority TEXT NOT NULL DEFAULT 'medium';

ALTER TABLE push_subscriptions ADD COLUMN prefs TEXT;
`;
