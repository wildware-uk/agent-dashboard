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
