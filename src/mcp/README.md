# `src/mcp` — the agent-facing adapter

**One job:** the MCP Streamable HTTP tool surface, mounted by `src/http/` at
`POST /mcp`. Handlers stay thin: validate with zod, resolve the agent from the
bearer token, call a domain function, format the result.

**May import:** `$domain`, `$config`.

**Must not:** touch the database or the event bus directly. If a tool needs a new
behaviour, it belongs in `src/domain/` and is called from here.

Notes carried from the design (§5):

- Auth is `Authorization: Bearer <token>`; every tool resolves the calling agent
  from that token. **No tool accepts an agent identifier as an argument**, so one
  agent cannot post as another.
- Fourteen tools: `create_project`, `list_projects`, `post_update`,
  `create_upload`, `attach_media`, `register_session`, `heartbeat`,
  `end_session`, `list_tasks`, `claim_task`, `complete_task`, `get_messages`,
  `request_approval`, `await_approval`.
- `heartbeat` piggybacks unread/task/approval counts so an agent discovers work
  without polling three tools.
- Integration tests drive these through a real SDK client over real HTTP with
  real auth (§9) — that is what catches schema and transport mistakes.

Public entry point: `src/mcp/index.ts`.
