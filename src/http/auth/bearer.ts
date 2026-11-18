/**
 * The bearer token on a request, if it carries one.
 *
 * A phone of the owner's sends its device key this way instead of the session
 * cookie. Which keys are live is not known here — `src/http/auth/` touches no
 * database — so the hook is handed a checker by `src/hooks.server.ts`.
 */

/** A device key check: does this token belong to one of the owner's phones? */
export type DeviceTokenCheck = (token: string) => boolean;

/** The token from `Authorization: Bearer <token>`, or `null` when there is none. */
export function bearerToken(headers: Headers | null | undefined): string | null {
	const value = headers?.get('authorization')?.trim() ?? '';
	const match = /^bearer\s+(\S+)$/i.exec(value);
	return match ? match[1] : null;
}
