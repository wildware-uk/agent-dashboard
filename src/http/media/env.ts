/**
 * The media settings, or nothing.
 *
 * Same shape as `src/http/auth/env.ts` and `src/mcp/env.ts`, for the same
 * reason: validation rules live in `src/config.ts`, and a request path must not
 * throw a configuration error at a caller. A deployment whose environment does
 * not validate has no `TOKEN_SECRET` to verify an upload token with and no
 * `DATA_DIR` to write into, so both media routes answer "not configured" rather
 * than guessing.
 */
import { mediaSettings, type MediaSettings } from '$media';

export function mediaConfig(env = process.env): MediaSettings | null {
	try {
		return mediaSettings(env);
	} catch {
		return null;
	}
}
