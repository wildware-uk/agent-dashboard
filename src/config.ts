/**
 * Configuration, exclusively from the environment (design §10).
 *
 * A leaf module: it imports nothing from the tree, so every other module may
 * import it. `loadConfig` takes the environment as an argument rather than
 * reading `process.env` itself, which keeps it a pure function and lets tests
 * exercise the validation without mutating global state.
 */
import { z } from 'zod';

/** Every variable this app understands, in the order `.env.example` lists them. */
export const CONFIG_VARS = [
	'DATA_DIR',
	'ADMIN_PASSWORD_HASH',
	'SESSION_SECRET',
	'TOKEN_SECRET',
	'PUBLIC_BASE_URL',
	'MAX_IMAGE_BYTES',
	'MAX_VIDEO_BYTES',
	'HOLD_S'
] as const;

export type ConfigVar = (typeof CONFIG_VARS)[number];

/** Long enough that an HMAC key or cookie-signing key is not guessable. */
const MIN_SECRET_LENGTH = 32;

const bytes = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const secret = (name: string) =>
	z
		.string({ error: `${name} is required` })
		.min(MIN_SECRET_LENGTH, `${name} must be at least ${MIN_SECRET_LENGTH} characters`);

const schema = z.object({
	/** Root of the runtime data directory: SQLite file plus `media/`. */
	DATA_DIR: z.string().min(1).default('data'),

	/** argon2id hash of the owner's password. `.env.example` has the one-liner. */
	ADMIN_PASSWORD_HASH: z
		.string({ error: 'ADMIN_PASSWORD_HASH is required' })
		.startsWith('$argon2id$', 'ADMIN_PASSWORD_HASH must be an argon2id hash'),

	/** Signs the owner's session cookie. */
	SESSION_SECRET: secret('SESSION_SECRET'),

	/** HMAC key for agent tokens and upload tokens. */
	TOKEN_SECRET: secret('TOKEN_SECRET'),

	/** Absolute public origin, used to build upload and media URLs for agents. */
	PUBLIC_BASE_URL: z
		.string()
		.default('http://localhost:5173')
		.refine((value) => /^https?:\/\/[^/]+/.test(value), {
			error: 'PUBLIC_BASE_URL must be an absolute http(s) URL'
		})
		.transform((value) => value.replace(/\/+$/, '')),

	/** Upload cap for images (design §6). */
	MAX_IMAGE_BYTES: bytes(10 * 1024 * 1024),

	/** Upload cap for video (design §6). */
	MAX_VIDEO_BYTES: bytes(200 * 1024 * 1024),

	/**
	 * How long `request_approval` parks on the event bus before handing the agent
	 * a `pending` result to poll on. Must stay under the 60 second tool timeout
	 * common to MCP clients (design §5).
	 */
	HOLD_S: z.coerce.number().int().min(1).max(59).default(55)
});

export type Config = z.output<typeof schema>;

/** Environment as Node hands it to us: every value a string, or absent. */
export type RawEnv = Partial<Record<string, string | undefined>>;

/**
 * Validate and normalise the environment.
 *
 * @throws an `Error` whose message names every offending variable, so a
 *   misconfigured deployment fails at boot with something actionable in the log
 *   rather than at the first request.
 */
export function loadConfig(env: RawEnv): Config {
	// Drop empty strings so `FOO=` in a .env file means "unset", not "invalid".
	const present: RawEnv = {};
	for (const name of CONFIG_VARS) {
		const value = env[name];
		if (value !== undefined && value !== '') present[name] = value;
	}

	const result = schema.safeParse(present);
	if (result.success) return result.data;

	const problems = result.error.issues.map((issue) => {
		const name = issue.path[0];
		return name === undefined ? issue.message : `${String(name)}: ${issue.message}`;
	});
	throw new Error(`Invalid configuration:\n  ${problems.join('\n  ')}`);
}

/**
 * Refuse to boot a proxied deployment that would mis-key its rate limiter.
 *
 * adapter-node derives `getClientAddress()` from the socket peer unless
 * `ADDRESS_HEADER` names a forwarded-for header. Behind the reference Caddy
 * deployment (design §12) that peer is always `127.0.0.1`, so every visitor on
 * the internet shares one rate-limit bucket and five wrong password guesses from
 * a stranger lock the owner out for the window.
 *
 * An `https://` PUBLIC_BASE_URL means something else is terminating TLS, which
 * means a proxy, which means the header is required. `TRUST_SOCKET_ADDRESS=true`
 * is the escape hatch for the rare deployment terminating TLS in this process.
 *
 * @throws an `Error` naming the variables to set.
 */
export function assertClientAddressTrustworthy(env: RawEnv): void {
	const proxied = (env.PUBLIC_BASE_URL ?? '').startsWith('https://');
	if (!proxied) return;
	if (env.TRUST_SOCKET_ADDRESS === 'true') return;
	if ((env.ADDRESS_HEADER ?? '') !== '') return;

	throw new Error(
		'Invalid configuration:\n' +
			'  PUBLIC_BASE_URL is https, so a reverse proxy is terminating TLS, but\n' +
			'  ADDRESS_HEADER is unset. Every request would report the proxy as its\n' +
			'  client address, so the login rate limiter would treat all visitors as\n' +
			'  one client and any stranger could lock the owner out.\n' +
			'  Set ADDRESS_HEADER=X-Forwarded-For and XFF_DEPTH=1 (one proxy), or set\n' +
			'  TRUST_SOCKET_ADDRESS=true if this process really does face the internet.'
	);
}

/** Bytes in each suffix adapter-node accepts for `BODY_SIZE_LIMIT`. */
const BYTE_SUFFIXES: Record<string, number> = {
	K: 1024,
	M: 1024 * 1024,
	G: 1024 * 1024 * 1024
};

/** adapter-node's own default when `BODY_SIZE_LIMIT` is unset. */
export const ADAPTER_BODY_SIZE_DEFAULT = '512K';

/**
 * Parse a `BODY_SIZE_LIMIT` value the way adapter-node does.
 *
 * @returns the value in bytes, or `null` if it is not a value the adapter would
 *   accept (it refuses to boot on those itself, so this does not second-guess it).
 */
export function parseBodySizeLimit(raw: string): number | null {
	const match = /^(\d+)([KMG])?$/.exec(raw.trim());
	if (!match) return null;
	const multiplier = match[2] ? BYTE_SUFFIXES[match[2]] : 1;
	return Number(match[1]) * multiplier;
}

/**
 * Refuse to boot when the adapter would reject uploads the app promises to accept.
 *
 * `BODY_SIZE_LIMIT` is enforced by adapter-node before any route runs, so a value
 * below `MAX_VIDEO_BYTES` rejects large uploads with a 413 this app never sees and
 * cannot explain — the agent gets an opaque failure and its upload token is spent.
 * The adapter's default of 512K is far below the defaults here, so the common case
 * is a deployment that never sets it at all.
 *
 * @throws an `Error` naming the value to set.
 */
export function assertBodyLimitAllowsUploads(env: RawEnv, config: Config): void {
	const raw = env.BODY_SIZE_LIMIT ?? ADAPTER_BODY_SIZE_DEFAULT;
	const limit = parseBodySizeLimit(raw);
	// An unparseable value is the adapter's error to report, not ours.
	if (limit === null) return;

	const largest = Math.max(config.MAX_IMAGE_BYTES, config.MAX_VIDEO_BYTES);
	if (limit >= largest) return;

	throw new Error(
		'Invalid configuration:\n' +
			`  BODY_SIZE_LIMIT is ${raw} (${limit} bytes) but this deployment accepts uploads\n` +
			`  up to ${largest} bytes. adapter-node enforces BODY_SIZE_LIMIT before any route\n` +
			'  runs, so larger uploads would be rejected with a 413 the app never sees and\n' +
			'  cannot explain, after the agent has already spent its upload token.\n' +
			`  Set BODY_SIZE_LIMIT=${largest} (or lower MAX_IMAGE_BYTES / MAX_VIDEO_BYTES).`
	);
}
