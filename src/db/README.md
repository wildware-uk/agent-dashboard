# `src/db` — persistence

**One job:** own the SQLite connection, run numbered migrations, and expose one
repository module per entity in plain SQL.

**May import:** nothing from `src/` (except `$config`). This is a leaf.

**Must not:** contain business rules, HTTP/MCP types, or knowledge of why a row
is being written. A repository takes plain arguments and returns plain objects.

## Entry points

- `$db` — the production surface: connection, migration runner, row types, and
  every repository function. Import from here, never from a file inside.
- `$db/testing` — `freshDatabase()`: an in-memory SQLite with every migration
  applied, isolated per call, plus `withDatabase(fn)` when a test makes enough of
  them that closing matters. Separate from `$db` so no production path can reach
  for a throwaway database.

```ts
import { freshDatabase } from '$db/testing';
import { insertProject, insertUpdate } from '$db';

const db = freshDatabase();
const project = insertProject(db, { slug: 'dashboard', name: 'Dashboard' });
```

## Layout

| File                | Holds                                                                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `connection.ts`     | `openDatabase`, `getDatabase`, pragmas. **The only file in the tree that imports `better-sqlite3`** — `connection.test.ts` enforces that. |
| `migrate.ts`        | The runner: applies pending migrations in order, records them in `schema_migrations`.                                                     |
| `migrations/`       | Numbered, append-only SQL. `001-initial-schema.ts` is the whole data model.                                                               |
| `schema.ts`         | The table list as data.                                                                                                                   |
| `ids.ts`            | ULID minting.                                                                                                                             |
| `types.ts`          | The row shapes repositories return.                                                                                                       |
| `rows.ts`           | The 0/1 and JSON-text conversions SQLite forces on us.                                                                                    |
| one file per entity | `projects`, `agents`, `sessions`, `updates`, `media`, `derivatives`, `upload-tokens`, `tasks`, `messages`, `read-cursors`, `approvals`.   |

## Conventions

- SQLite in WAL mode, one file at `$DATA_DIR/agent-dashboard.db`.
- Every table has `seq INTEGER PRIMARY KEY AUTOINCREMENT` plus a text ULID `id`
  (§3). `AUTOINCREMENT` never reuses a value, so a cursor a browser is holding
  can never come to mean a different row.
- **Timestamps are INTEGER milliseconds since the epoch**, everywhere. Repository
  functions that stamp a time take it as an argument defaulting to `Date.now()`,
  so tests can be deterministic without faking the clock.
- Booleans are stored 0/1 and returned as `boolean`; `meta`, `options` and
  `mime_allow` are stored as JSON text and returned decoded. Nothing else is
  interpreted.
- `STRICT` tables and `CHECK` constraints on every enumeration in the design, so
  a bad `level` or `state` fails at the write.
- Deletes are soft (`deleted_at`) so a connected browser can be told to remove a
  row it has already rendered. `media` is the exception: its bytes are gone, so
  the row goes with them.
- State transitions that can race — claiming a task, deciding an approval,
  spending an upload token — are a **single conditional `UPDATE ... RETURNING`**.
  The loser gets `undefined`, never a half-written row.
- Migrations are **append-only**. The runner records a checksum and refuses to
  start if a migration that has already been applied has changed since.
