/**
 * The environment values the media pipeline needs (design §10).
 *
 * Bundled into one object and passed as an argument for two reasons. Tests get a
 * throwaway data directory and a known secret without touching `process.env`
 * (see `./testing.ts`), and — the load-bearing one — `baseUrl` is `PUBLIC_BASE_URL`,
 * so nothing in this module can be tempted to build an upload URL out of the
 * bind address. An agent handed `http://127.0.0.1:8010/api/upload/...` cannot
 * upload anything (design §12).
 *
 * Unlike `src/http/auth/env.ts` this throws rather than returning `null`. Auth
 * fails *closed* by refusing requests; an upload has nowhere to fail closed to —
 * without a secret there is no token to mint and no bytes to store, so the
 * honest answer is an error the owner sees in the log.
 */
import { loadConfig, type RawEnv } from '$config';

export type MediaSettings = {
	/** `DATA_DIR`: media lives under `<dataDir>/media`, temp files under `<dataDir>/tmp`. */
	dataDir: string;
	/** `TOKEN_SECRET`: the HMAC key upload tokens are signed with (design §8). */
	tokenSecret: string;
	/** `PUBLIC_BASE_URL`: the externally reachable origin, with no trailing slash. */
	baseUrl: string;
	/** `MAX_IMAGE_BYTES`. */
	maxImageBytes: number;
	/** `MAX_VIDEO_BYTES`. */
	maxVideoBytes: number;
};

/**
 * Read the settings out of the environment.
 *
 * @throws the `Error` from `loadConfig`, naming every offending variable.
 */
export function mediaSettings(env: RawEnv = process.env): MediaSettings {
	const config = loadConfig(env);
	return {
		dataDir: config.DATA_DIR,
		tokenSecret: config.TOKEN_SECRET,
		baseUrl: config.PUBLIC_BASE_URL,
		maxImageBytes: config.MAX_IMAGE_BYTES,
		maxVideoBytes: config.MAX_VIDEO_BYTES
	};
}
