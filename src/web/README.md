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
  open tasks rail. Mobile is one column with the sidebar as a drawer and the rail
  as a second drawer, so nothing that only lives in the rail is lost on a phone.
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
| `UpdateCard.svelte`                 | One update: level colour, avatar, markdown, media grid.                                      |
| `MediaGrid.svelte`                  | The grid on a card, and the lightbox it opens (§7).                                          |
| `MediaTile.svelte`                  | One cell: the placeholder, the failed state, the image, the inline video.                    |
| `Lightbox.svelte`                   | Full-size viewing, keyboard navigable, focus trapped and returned.                           |
| `media.ts`                          | Pure media decisions: addresses, cell shapes, sources, labels.                               |
| `Markdown.svelte`                   | The only `{@html}` in the client.                                                            |
| `RightRail.svelte`                  | Live agents with their session metadata (§7).                                                |
| `Tasks.svelte`                      | The task list — todo, claimed, done — plus creating, assigning and cancelling (§7).          |
| `tasks.svelte.ts`                   | The task store: the list, live on `task.created` and `task.updated` (§5, §7).                |
| `stream.ts`                         | The tab's one connection to `/api/stream`, shared by every consumer (§4).                    |
| `timeline.svelte.ts`                | The client store: snapshot, stream, pending arrivals, paging.                                |
| `presence.svelte.ts`                | The live-agents store: who is online, derived against a ticking clock (§4).                  |
| `threads.svelte.ts`                 | The page's message threads: one request for every card, live on `message.created` (§7).      |
| `Thread.svelte`                     | One card's conversation, and the box the owner replies in (§7).                              |
| `actions.ts`                        | The owner's write calls: create, rename, pin, archive, delete (§7).                          |
| `NewProject.svelte`                 | Create a project from the browser.                                                           |
| `ProjectActions.svelte`             | Per-project menu: pin, rename, re-describe, archive, unarchive.                              |
| `UpdateActions.svelte`              | Per-card pin, and delete behind a confirmation.                                              |
| `markdown.ts`                       | markdown-it with **`html: false`**.                                                          |
| `avatar.ts`, `levels.ts`, `days.ts` | Pure helpers: name hash, level palette, day grouping.                                        |
| `types.ts`                          | The wire shapes, declared here because this module may not import `$db`.                     |
| `testing.ts`                        | Test-only fakes: a scripted `EventSource` and a fake snapshot API.                           |

## The task panel

A plain per-project list across todo, claimed and done, with no drag and drop —
which the design asks for (§7) and the surface argues for: 17rem in the rail, a
thumb's width on a phone.

**The owner creates and steers; the agent claims and completes.** So the panel
offers exactly two writes — put work on a project, and reassign or withdraw it —
and no control that would mark work done. Claiming is `claim_task` over MCP, and
a browser that could fake it would be a browser that lies about who did the work.

**Nothing renders optimistically.** A control awaits its call, the server
publishes `task.created` or `task.updated`, and the change comes back through the
store on the stream — the same route it takes when an agent claims something from
the other side of the world. That is why "a claim appears with no reload" and
"the owner's own click appears" are one code path rather than two.

**One store, two mounts.** The panel is in the rail on a desktop and in the rail
drawer on a phone, because §7 is explicit that information which only exists in
the rail must still be reachable on a small screen. The store refcounts its
holders, so closing the drawer does not unsubscribe the rail's copy.

## The conversation on a card

The owner replies on a card and the thread renders inline (§7). Three decisions
shape it, and all three come from the transport rather than from taste.

**One request for the whole page, not one per card.** A timeline holds fifty
cards and almost none of them have replies, so `threads.svelte.ts` reads every
message in scope in one go and hands each card its own by id. A card that fetched
for itself would turn one page load into fifty requests to learn that nothing
happened.

**Nothing is inserted optimistically.** The reply box `await`s the post and then
does nothing: the write publishes `message.created`, the tab hears it on its own
stream and the store refetches, so the reply lands in the tab that sent it by
exactly the path it lands in a tab that was only watching. That is the same rule
`actions.ts` keeps for every other control, and it is why there is no state here
that can disagree with the server.

**A message body is untrusted like any other.** It renders through
`Markdown.svelte`, whose renderer has raw HTML disabled (§8), so an agent that
replies with `<script>` puts a `<script>` on the screen and not one in the
owner's browser. `Thread.svelte.spec.ts` asserts that in a real browser rather
than trusting the string test alone.

## Media on a card

Three things a media grid has to get right, and all three are decided before
anything is fetched (§6, §7).

**The box comes from the stored dimensions.** A cell's aspect ratio is set from
`width`/`height` on the row, so the space an image will take is reserved at first
paint and the timeline does not jump as thumbnails load. A card carrying three or
four shots gets one uniform cell shape instead, because the alternative in a
narrow column is a staircase — and a uniform cell is a decided box for the states
that have nothing to show yet, too.

**The browser only asks for an address that exists.** The row carries the list of
variants the pipeline has produced, and every source is chosen from it. That is
not defensive: a web-playable mp4 gets no transcode (`src/media/derive.ts`), so
`/media/:id/video` 404s for exactly the videos that needed no work, and guessing
would give the owner a broken player. Video plays inline from its poster frame
with `preload="none"`, so a card costs one jpeg until somebody presses play.

**The swap is the transport, not a special case.** `media.ready` is watched by
the store like every other event: it refetches the page and reconciles by id, the
replacement row carries its new variants, and the placeholder becomes the image.
No component subscribes to anything, nothing reloads, and `Shell.svelte.spec.ts`
holds on to the card's DOM node across the swap to prove it.

A `pending` item is a labelled placeholder and a `failed` one says so in words —
never an `<img>` with no source, which is a broken icon and a mystery, and never
a variant address, because every one of them 404s for a failed row.

The lightbox holds only what can be enlarged, which is images: video plays where
it sits rather than becoming a stop on the way through a card. It takes focus on
open, keeps `Tab` inside itself, and hands focus back to the cell that opened it,
because a reader who closes a dialog from halfway down a long timeline must not
be dumped at the top of the document.

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

## Presence in the browser

`presence.svelte.ts` is the client half of "presence is derived, never a stored
flag" (§4). It holds the rows the server sent and answers `online` against **its
own clock**, ticking once a second, so an agent that has been quiet for 90s
leaves the rail without any event arriving — because nothing happens when an
agent goes quiet, and a rail that waited for something to happen would show a
green dot beside a dead run.

An `agent.presence` frame is a reason to refetch, like every other event. The
slow poll alongside it is not redundant: a heartbeat inside the window
deliberately publishes nothing, so without it the rail would sit on a heartbeat
timestamp that ages until it looked offline.

It does not open a connection of its own. It takes a hold on the tab's one
stream, like the timeline store and like anything the page grows next — see
below.

## One connection, however many things are watching

`stream.ts` is the whole of the browser's connection management, and it exists
because two connections per tab was not untidiness but an outage (#19).

Browsers allow **six sockets per origin on HTTP/1.1**, an SSE connection holds
one for as long as the page is open, and nothing else on the origin can jump
that queue. The timeline store used to open one and the rail's store another, so
three tabs reached the limit and the origin went dead: snapshots never resolved,
media never loaded, navigation timed out. It reads as "the dashboard is broken"
rather than "too many tabs". HTTP/2 hides it, which the reference Caddy
deployment provides — and the README quickstart is plain HTTP on localhost,
which does not.

Two layers, answering two different arithmetics:

**`SharedStream` — one connection per tab.** A ref-counted hub. A consumer
subscribes with the event types it cares about and is handed a `Subscription`;
the first subscriber opens the connection, the last one to leave closes it. So a
region that unmounts cannot take the stream away from the regions still on the
page, and cannot leave a listener on it either. `Timeline` and `Presence` both
default to `sharedStream()`, which is why the shell mounting both of them costs
one request.

**`LeaderLink` — one connection per browser.** Six tabs holding one socket each
is _exactly_ the limit, so per-tab sharing on its own still hangs the origin at
six tabs. The Web Locks API elects one tab across the whole origin; that tab is
the only one with an `EventSource`, and it rebroadcasts every frame on a
`BroadcastChannel`. Twenty tabs then cost one socket. The lock is released by the
browser when the leading tab closes or crashes, so a queued tab is granted it and
takes over with no protocol of ours; the ping and the steal in that class cover
the one case the lock cannot see, which is a tab that still holds it but has
stopped running. Where Web Locks is missing — a page served to a hostname over
plain HTTP is not a secure context — the tab keeps its own connection, which is
still one rather than one per store.

None of this changes what a store is written against. The resume cursor is still
`last_event_id` in the query string (`EventSource` cannot set headers), a
reconnect the browser performs itself still carries `Last-Event-ID`, `resync` is
forwarded like any other event, and each consumer still sees only the types it
subscribed to.

## The owner's actions

`actions.ts` is the store's mirror: the store reads, it writes. Nothing in it
touches client state, and that is the design's consistency rule rather than an
omission — a write reaches the server, the server publishes, and the change comes
back on the stream to _every_ tab including the one that made it. So a control
awaits its call and then does nothing, there is no optimistic edit to reconcile,
and the tab that acted cannot end up disagreeing with the tab that watched.

The controls are opt-in: `Sidebar.svelte`, `Timeline.svelte` and
`UpdateCard.svelte` grow them only when handed an `OwnerActions`, which is what
keeps each of them renderable — and testable — with nothing behind it.
`Shell.svelte` passes the real client down in production and a spec passes a fake.

Two rules the components follow. Delete asks first, inline rather than through
`window.confirm`, because a native dialog is untestable, unstyleable and blocks
the tab including its stream. And a refused call keeps the form open holding what
was typed, because retyping a description to discover the name was the problem is
nobody's idea of a good time.

Pinned updates sort first by being lifted clear of the day groups into their own
section, not by being reordered inside one: an update pinned three weeks ago
belongs at the top of the feed, not at the top of "3 August".

The pill is not a decoration. While the reader cannot see the top of the
timeline, arrivals are held in `pending` instead of being inserted, so nothing
above the reader changes and the viewport cannot move; returning to the top, or
clicking the pill, releases them. The connection status is rendered in the shell
header rather than in the timeline for the same reason — anything that can appear
above the cards would shift them.
