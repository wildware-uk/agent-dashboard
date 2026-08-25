# `src/web` — the browser UI

**One job:** Svelte components and client stores. Also reachable as `$lib`, since
`vite.config.ts` sets `files.lib` here.

**May import:** nothing from `src/` other than `$config`-free client code. Its
only data source is the HTTP API — fetch and the SSE stream.

**Must not:** import `$db`, `$domain`, `$media`, `$mcp`, or anything server-only.
This code ships to the browser.

Notes carried from the design (§7):

- Dark-first, system-aware. The theme is resolved before first paint in
  `src/app.html` and written to `<html data-theme>`; Tailwind's `dark:` variant
  follows that attribute. Semantic tokens (`surface`, `content`, `accent`, …) are
  defined in `src/http/routes/app.css`.
- Desktop is three regions: project sidebar, update timeline, live agents +
  open tasks rail. Mobile is one column with the sidebar as a drawer.
- **Pending approvals get a sticky top banner, not a rail item** — an approval is
  the one case where an agent is stopped dead waiting on the owner.
- Agent markdown is untrusted: render with raw HTML disabled (§8).
- New items animate in; if the timeline is scrolled away from the top, show a
  "N new" pill instead of jumping the view.

## What is in here

| File                                | Job                                                                                          |
| ----------------------------------- | -------------------------------------------------------------------------------------------- |
| `Shell.svelte`                      | The three-region layout, the header, the mobile drawer, and the one store instance per page. |
| `Sidebar.svelte`                    | Projects, pinned first, archived behind a toggle.                                            |
| `Timeline.svelte`                   | The scroll container, the day groups, and the "N new" pill.                                  |
| `UpdateCard.svelte`                 | One update: level colour, avatar, markdown, media region.                                    |
| `Markdown.svelte`                   | The only `{@html}` in the client.                                                            |
| `RightRail.svelte`                  | Placeholder for live agents and open tasks (§7).                                             |
| `timeline.svelte.ts`                | The client store: snapshot, stream, pending arrivals, paging.                                |
| `markdown.ts`                       | markdown-it with **`html: false`**.                                                          |
| `avatar.ts`, `levels.ts`, `days.ts` | Pure helpers: name hash, level palette, day grouping.                                        |
| `types.ts`                          | The wire shapes, declared here because this module may not import `$db`.                     |
| `testing.ts`                        | Test-only fakes: a scripted `EventSource` and a fake snapshot API.                           |

## How the client stays correct

The store follows the contract in `src/http/README.md`, and two properties of the
transport shape everything it does:

1. **Events carry identifiers, not data.** `update.created` knows an id and
   nothing else, so an arrival is a reason to refetch a small newest-first page
   and reconcile by id — never a row to render. Double delivery, replay after a
   reconnect and out-of-order frames are then all harmless.
2. **A snapshot is stamped with the seq it is good to.** Frames at or below that
   seq are dropped rather than refetched, which is what stops a reconnect's
   replay from becoming a request storm.

`update.deleted` is the exception that proves the rule: the id _is_ the whole
payload, so the card is dropped with no request at all.

The pill is not a decoration. While the reader cannot see the top of the
timeline, arrivals are held in `pending` instead of being inserted, so nothing
above the reader changes and the viewport cannot move; returning to the top, or
clicking the pill, releases them. The connection status is rendered in the shell
header rather than in the timeline for the same reason — anything that can appear
above the cards would shift them.
