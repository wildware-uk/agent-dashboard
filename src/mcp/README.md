# `src/mcp` — the agent-facing adapter

**One job:** the MCP Streamable HTTP tool surface, mounted by `src/http/` at
`POST /mcp`. Handlers stay thin: validate with zod, resolve the agent from the
bearer token, call a domain function, format the result.

**May import:** `$domain`, `$config`.

**Must not:** touch the database or the event bus directly. If a tool needs a new
behaviour, it belongs in `src/domain/` and is called from here.

Public entry point: `src/mcp/index.ts`. `testing.ts` is a second, test-only
entry point and is not re-exported from it.

## What is here

| File            | Holds                                                                           |
| --------------- | ------------------------------------------------------------------------------- |
| `server.ts`     | `createMcpHandler` (the route's handler) and `createMcpServer`. The wiring.     |
| `auth.ts`       | Bearer parsing, token shape, rate-limit key, identity. One verdict per request. |
| `rate-limit.ts` | Per-token sliding window (design §8).                                           |
| `responses.ts`  | The 401 / 429 / 503 answers given before a tool is ever reached.                |
| `env.ts`        | `TOKEN_SECRET` from `$config`, or `null` — the surface fails closed.            |
| `results.ts`    | Domain objects and domain errors, as tool results.                              |
| `tools/`        | One file per tool, plus `TOOLS` and `registerTools`.                            |

## The request path

```
POST /mcp
  ├─ no TOKEN_SECRET ................................ 503 server_not_configured
  ├─ no / non-Bearer Authorization .................. 401 + WWW-Authenticate: Bearer
  ├─ token is not 43 chars of base64url ............. 401 malformed_token
  ├─ over the per-token window ...................... 429 + Retry-After
  ├─ token unknown, or revoked ...................... 401 unknown_token | revoked_token
  └─ agent resolved → tools bound to that agent → JSON-RPC answer
```

The order is not arbitrary: nothing that could be expensive happens before the
cheap refusals, and the rate limit is spent only once a request holds something
that could plausibly be a token — so a client looping on a bad token is
throttled, while a request with no credentials costs nothing to refuse.

## Decisions worth knowing before changing them

- **Identity comes from the token, and only from the token** (design §5). The
  server is built per request with the calling agent already bound into every
  tool, so a handler has no argument for an agent and nothing global to reach
  for. `tools/index.test.ts` asserts no tool schema has an agent-shaped argument
  at all, and the integration test proves attribution over the wire.
- **The transport is stateless.** No `Mcp-Session-Id`, one server and one
  transport per HTTP request, JSON responses rather than an SSE stream per call.
  Revocation therefore bites on the very next call, and nothing can leak between
  requests. The cost is no server-initiated push: `GET /mcp` is a 405, which the
  SDK client reads as "this server does not push". The approval gate (§5) is a
  bounded long-poll for exactly that reason, so nothing in the design needs it.
- **Tokens are 256-bit random values, stored as HMAC-SHA256 under
  `TOKEN_SECRET` and confirmed in constant time** (§8). All of that lives in
  `src/domain/agents.ts`, because the `mint-token` CLI (§10) and the owner UI
  mint tokens too, and a token must only ever be created one way.
- **The rate limiter is keyed on the token's HMAC**, never the token and never
  the agent id: a heap dump yields nothing usable, and requests carrying unknown
  tokens are limited as well.
- **A `DomainError` becomes a tool error with its code** (`invalid_argument`,
  `not_found`, `conflict`); anything else is logged and reported as
  `internal_error`. An agent can act on the first kind and should not be handed
  the internals of the second.
- **Tool descriptions are the product's API documentation** (§5). They are
  written for an agent, and they state what every argument accepts — as does
  every field's zod `.describe()`, which is what a client renders inline.
  `tools/index.test.ts` fails if an argument is undocumented in either place.
- **`/mcp` is exempt from the owner's session guard by path**
  (`src/http/auth/guard.ts`). Agents must never meet the session cookie, and the
  integration test proves both halves: a bearer-token request with no cookie
  succeeds, and a guarded route with no cookie is still refused.

## Tools

Eight of the fourteen in design §5 are built (§11 steps 5, 9 and 12):

| Tool               | Takes                                                                           | Does                                               |
| ------------------ | ------------------------------------------------------------------------------- | -------------------------------------------------- |
| `create_project`   | `name`, `slug?`, `description?`                                                 | Idempotent on slug; returns `created`.             |
| `list_projects`    | `status?`                                                                       | Sidebar order: pinned first, then newest.          |
| `post_update`      | `project` (slug or id), `body`, `title?`, `level?`, `media_ids?`, `session_id?` | Posts to the timeline; publishes `update.created`. |
| `create_upload`    | `filename`, `mime`, `bytes`                                                     | Mints a single-use upload URL, 15 minute TTL.      |
| `attach_media`     | `update_id`, `media_ids`                                                        | For bytes that land after the post. Retry-safe.    |
| `register_session` | `meta?` (`{host, cwd, model}`)                                                  | Opens a session; returns `heartbeat_interval_s`.   |
| `heartbeat`        | `session_id`                                                                    | Stays online; piggybacks the three work counts.    |
| `end_session`      | `session_id`                                                                    | Closes the run. Idempotent.                        |

`post_update` takes `media_ids` and refuses the whole post if any id is not the
caller's to attach — an image an agent believes it published must not be silently
dropped. `attach_media` takes the opposite line and _skips_ such ids, because the
likeliest reason to call it twice is that the first call worked and the answer was
lost. It also takes an optional `session_id` (issue #21), which is what fills in
`updates.session_id` from §3 and lets a card be traced back to the run that posted
it; optional, because an agent that never registered a session still has updates
worth posting.

`create_upload` returns an **absolute** `upload_url` built from
`PUBLIC_BASE_URL`. An agent runs on another machine, so a URL built from the bind
address would be one it can never use (§12). The bytes then go to
`PUT /api/upload/:token`, whose refusals are statuses rather than tool errors: 403
for a spent or expired token, 413 for a body past the declared size, 415 for bytes
that are not the declared type.

`post_update`, `heartbeat` and `end_session` take a `session_id`, which is the one
identifier a tool accepts. It is a handle on a run, not a claim about who is
calling: the domain refuses a session belonging to another agent with
`invalid_argument`, so a stolen id buys nothing. `tools/index.test.ts` asserts
that for every tool that takes one, which is a stronger guarantee than keeping the
argument out of the schema would be. Each of those tools names every code it can
refuse with in its own description — `not_found`, `invalid_argument`, and for
`heartbeat` `conflict` — because an agent cannot handle an error it was never told
about.

Still to come, in build order (§11):
`list_tasks` / `claim_task` / `complete_task` (13), `get_messages` (14),
`request_approval` / `await_approval` (15).

## Testing

`mcp.integration.test.ts` is the one that matters: it starts a real Node HTTP
server, wraps it in the **production** session-guard hook, and drives the tools
with the SDK's own client over real HTTP with a real minted token (design §9).
That is what catches a zod shape the SDK cannot convert, a header the transport
insists on, or a guard that has quietly started swallowing `/mcp`. Everything
else is unit-tested against functions.

```ts
import { mcpHarness } from '$mcp/testing';

const mcp = mcpHarness(); // a harness, an agent, a real token, and ToolDeps
```
