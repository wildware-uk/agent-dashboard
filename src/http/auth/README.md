# `src/http/auth` — owner auth

**One job:** prove the browser belongs to the owner, and say which paths that
proof is required for.

**May import:** `$config` and node builtins only. It is a leaf of `src/http/`: no
domain calls, no database, no event bus. There is one owner and no user table
(design §8), so there is nothing to look up.

| File            | Job                                                                                   |
| --------------- | ------------------------------------------------------------------------------------- |
| `session.ts`    | The signed cookie: mint, verify, and the HttpOnly / Secure / SameSite=Lax attributes. |
| `password.ts`   | argon2id verify against `ADMIN_PASSWORD_HASH`.                                        |
| `rate-limit.ts` | Sliding-window limiter, in memory, clock-injectable.                                  |
| `guard.ts`      | Path policy: what needs a session, and where to send visitors who lack one.           |
| `login.ts`      | The login decision: rate limit, verify, issue the cookie.                             |
| `logout.ts`     | Clear the cookie.                                                                     |
| `handle.ts`     | The policy as a SvelteKit `handle` hook, installed by `src/hooks.server.ts`.          |
| `env.ts`        | The two secrets, or `null` — the reason a broken environment fails closed.            |

Two things worth knowing before changing any of it:

- **`/mcp` must never be session-guarded.** Agents authenticate with bearer
  tokens (§5), and `/api/upload` with its own single-use token (§6). Both are
  exempt by whole-segment prefix in `guard.ts`, which is why `/mcp-docs` is still
  a guarded browser route.
- **The guard is in two places on purpose.** `handle.ts` covers everything,
  including `+server.ts` endpoints, which a layout load never sees;
  `routes/+layout.server.ts` covers pages a second time so page protection does
  not depend on the hook being wired up. Both read `guard.ts`, so there is one
  list of guarded paths.
