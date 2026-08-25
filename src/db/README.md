# `src/db` — persistence

**One job:** own the SQLite connection, run numbered migrations, and expose one
repository module per entity in plain SQL.

**May import:** nothing from `src/` (except `$config`). This is a leaf.

**Must not:** contain business rules, HTTP/MCP types, or knowledge of why a row
is being written. A repository takes plain arguments and returns plain objects.

Notes carried from the design:

- SQLite in WAL mode, one file under `DATA_DIR`.
- Every table has a text ULID `id` plus a `seq INTEGER` autoincrement, used for
  cursor pagination and event ordering (§3).
- Deletes are soft (`deleted_at`) so a connected browser can be told to remove a
  row it has already rendered.
- Tests run against a fresh in-memory database with migrations applied per test
  (§9).

Public entry point: `src/db/index.ts`.
