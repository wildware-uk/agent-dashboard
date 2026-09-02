# `src/cli` — the operator command line

**One job:** the commands an operator runs against a deployment from a shell,
built on the same functions the running server uses.

**May import:** `$config`, `$db`, `$domain`, `$http` (for `hashPassword`).

Public entry points: `src/cli/index.ts` (`run`, the command table) and
`src/cli/bin.ts` (the executable, built to `build/cli.js`).

## Why this exists

Two commands must run before the dashboard can be used at all, so neither can
live in the owner UI:

- `hash-password` produces `ADMIN_PASSWORD_HASH`, without which nobody can log in.
- `mint-token` creates the first agent token, which nobody can mint through a UI
  they cannot log into yet (design §10).

## Commands

| Command                    | Does                                                           |
| -------------------------- | -------------------------------------------------------------- |
| `mint-token <name>`        | Creates an agent, prints its bearer token once.                |
| `hash-password <password>` | argon2id hash for `ADMIN_PASSWORD_HASH`. `--stdin` also works. |
| `list-tokens [--revoked]`  | Agents by id and name. Tokens are not recoverable.             |
| `revoke-token <agent-id>`  | Switches a token off for good.                                 |
| `vapid-keys`               | Generates a Web Push keypair for `.env`. Needs no database.    |
| `backup <destination.db>`  | Online backup of the database, safe against a running server.  |
| `help`                     | Usage.                                                         |

## Decisions worth knowing before changing them

- **Nothing here hashes, HMACs, or writes a row.** `mintAgentToken`,
  `listAgents` and `revokeAgentToken` come from `$domain`; `hashPassword` comes
  from `$http/auth`. A token minted here and a token minted anywhere else are the
  same object made by the same code (design §8), so there is no second
  implementation to drift.
- **`run(argv, io)` never touches `process`.** The environment, both output
  streams and the database opener are arguments, so `index.test.ts` drives the
  real command table against an in-memory database. `bin.ts` is the only file
  that reads `process.argv` or sets an exit code.
- **Exit codes are load-bearing**: `0` fine, `1` the command ran and failed
  (bad configuration, no such agent), `2` the command line was wrong. A script
  that mints a token can tell "you typed it wrong" from "the deployment is
  misconfigured".
- **The CLI is bundled separately** (`vite.cli.config.ts` → `build/cli.js`)
  rather than run from source, because the Docker image installs production
  dependencies only and the source needs the toolchain to resolve `$` aliases.
