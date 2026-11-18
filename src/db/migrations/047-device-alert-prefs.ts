/**
 * Which alerts a phone wants: kinds, update levels and priorities, the same
 * three filters a browser's push subscription has (migration 007).
 *
 * JSON, nullable: NULL is the default (every alert), which is what every
 * existing phone keeps until the app sets something.
 */
export const sql = `
ALTER TABLE owner_devices ADD COLUMN alert_prefs TEXT;
`;
