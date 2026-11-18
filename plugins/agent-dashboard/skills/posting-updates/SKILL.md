---
name: posting-updates
description: Use when posting anything to the Agent Dashboard timeline - progress, a finish, a failure, a screenshot or a recording - or when correcting something you already posted. Covers level and priority, filing an update against a task, the three-step media upload, and correcting yourself with edit_update or edit_message.
---

# Posting updates worth reading

The timeline is a person's screen, not a log file. Every card costs them a
glance, so the bar is: **would they be worse off not seeing this?**

Post when you:

- finished something they were waiting on,
- hit a failure you are stuck on,
- are about to do something slow, expensive or irreversible,
- have a screenshot or a recording that answers a question faster than prose.

Do not post: every file you edited, every test run, "starting now", or the same
state twice. A timeline nobody reads is worse than no timeline, because it looks
like reporting.

## The call

```
post_update({
  project,          // slug or 26-char id
  body,             // markdown, ≤ 100,000 chars
  title?,           // ≤ 200 chars
  level?,           // info | success | warn | error
  priority?,        // low | medium | high
  task_id?,         // the task this is progress on
  media_ids?,       // ≤ 24 uploaded ids
  embeds?,          // ≤ 8 things drawn in a registered look
  session_id?       // from register_session
})
```

`body` renders as markdown — headings, lists, links, fenced code. Raw HTML is
shown as text, never executed, so do not try to style a card with it.

**Name the language on a fence** — ` ```ts `, ` ```python `,
` ```diff ` — and it is syntax highlighted; 193 languages are available. An
unnamed fence is guessed at, which is usually right but not always, so say it.

### level is what happened. priority is whether it can wait.

They are different questions and answering one with the other is the common
mistake.

|                    |                                                                          |
| ------------------ | ------------------------------------------------------------------------ |
| `level: info`      | progress. The default.                                                   |
| `level: success`   | something finished.                                                      |
| `level: warn`      | they should look at this.                                                |
| `level: error`     | a failure you are stuck on.                                              |
| `priority: low`    | noise-tolerant. A flaky test failed again.                               |
| `priority: medium` | the default.                                                             |
| `priority: high`   | **reaches their phone.** A migration is about to run against production. |

The owner filters push notifications on `priority`, per device. `high` is what
wakes somebody at 2am, so spend it like it costs money. An `error` that can wait
until morning is `level: error, priority: low`, and that combination is correct
rather than contradictory.

### Always pass task_id for claimed work

A task page shows every update filed against it, newest first, and the latest one
is its current status. A task you claimed and never posted against looks stalled
from the outside even while you are working on it. The task must be in the
project you are posting to.

### Pass session_id if you have one

It files the card against the run that made it, so the owner can trace a card
back to a session in their presence list. Omit it if you never registered.

## Files, in three steps

Bytes do not go through the MCP server. `create_upload` mints a single-use URL
with a 15 minute TTL, you PUT the bytes at it, and the id then names something
real.

```
1. create_upload({ filename, mime, bytes })  → { media_id, upload_url }
2. PUT upload_url  with the exact bytes and Content-Type: <mime>
3. post_update({ ..., media_ids: [media_id] })
```

`upload_url` is absolute and built from the deployment's `PUBLIC_BASE_URL`,
because you may not be on the dashboard's machine.

The PUT refuses with statuses rather than tool errors, and each means something
specific:

|       |                                                                     |
| ----- | ------------------------------------------------------------------- |
| `403` | the token is spent or expired. Mint a new one with `create_upload`. |
| `413` | the body is larger than the `bytes` you declared.                   |
| `415` | the bytes are not the `mime` you declared (rendered types only).    |

**Any type is accepted, not just pictures.** png, jpeg, webp, gif, mp4, webm,
quicktime, mp3, m4a (`audio/mp4`), ogg and wav render on the card — pictures,
players for video, and a play button for sound — and are checked against their
magic bytes; anything else — a PDF, a log, a CSV, a zip — is stored as a file
your owner downloads, and its declared type is only a label. Send `Content-Type: application/octet-stream`
on the PUT for those: the header is not what decides the stored type, but a
form-like one (`text/plain`, `multipart/form-data`) is refused as a cross-site
post, and no header at all means the body never arrives.

**`post_update` refuses the whole post if any media id is not yours or is already
used** — nothing is published half-illustrated. `attach_media({ update_id,
media_ids })` takes the opposite line and skips ids it cannot use, because the
likeliest reason to call it twice is that the first call worked and you lost the
answer. So: media you already have → `post_update`. Bytes that land after the
card → `attach_media`.

Up to 24 media per update.

## Embeds: showing a thing rather than pasting it

An embed draws something in the style of where it came from — a Slack message
with its channel and avatar, a GitHub comment, a Jira ticket, a Confluence page.
Use one instead of pasting a wall of quoted text.

```
1. list_embed_types()                        → which looks exist, and what each reads
2. post_update({ ..., embeds: [{
     type: "slack-message",
     data: { username: "sam", channel: "#deploys", time: "09:14",
             text: "the release is green", avatar: "<media_id or https URL>" },
     source_url: "https://…"                 // optional
   }] })
```

`slack-message`, `github-comment`, `jira-issue`, `confluence-page` and
`linked-page` ship with the dashboard, each shaped like the thing it quotes. If
none fits, `register_embed_type({ slug, name, spec })` adds your own.

A spec is a declaration, never HTML or CSS — everything you send is rendered as
text. It has three parts:

- **`chrome`** — how the card says where it came from: `mark` (one of `slack`,
  `github`, `gitlab`, `jira`, `confluence`, `linear`, `notion`, `figma`, `link`,
  drawn small in the corner), or `image` (a media id / https URL) for a source we
  draw no mark for, or `label` for a badge bar. Prefer `mark`.
- **`theme`** — hex colours, a font (`sans`/`serif`/`mono`), a corner radius.
- **`frame`** — the card: `border`, `stripe`, `padding`, and `indent`, which
  lines the body up under the header's _words_ rather than its avatar. That last
  one is Slack's shape.
- **`blocks`** — `header` (with `shape`, `size`, `layout: inline|stacked`, and
  `bar` for a GitHub-style tinted band), `heading`, `text` (with `tone`, `size`),
  `markdown`, `code`, `quote`, `fields`, `chips` (`style: pill|lozenge|tag`),
  `image`, `divider`, `footer`.

Copy a source's _shape_, not its name: the built-in Slack look carries no "Slack"
badge, because a Slack message does not have one. Registering the same slug again
replaces your look and restyles every embed already posted in it.

Strings in a spec may carry `{{name}}`, filled from the `data` you post. A block
whose values all come out empty is not drawn, so one look covers a message with
reactions and one without. `{{source_url}}` is filled from the `source_url` you
pass, and the badge along the top links there too.

Up to 8 embeds per post. An unknown `type` fails the whole post rather than
dropping the embed.

**Every card type takes the same two arguments.** `media_ids` and `embeds` work
identically on `post_update`, `post_message` and `request_input` —
an approval showing the screenshot it is asking about, a task showing the ticket
it came from. "Does this look right" is a question you cannot ask without the
thing being looked at.

## Apps: an interface, not a screenshot of one

An app is a real piece of UI you write and your owner uses on the card — a review
board they tick through, a chart of the run you are in the middle of, a form that
posts their answer straight back to you. It is the MCP Apps extension (SEP-1865)
with the roles the other way round: the dashboard is the host, you are the
server.

```
1. list_apps()                               → what is registered here already
2. register_app({ uri: "ui://review-board", name: "Review board",
                  html: "<!doctype html>…" })   → one self-contained document
   register_app({ uri: "ui://fix-queue", name: "Fix queue",
                  url: "https://fix.example.com/embed?q=open" })  → or a page a
                                                 service already serves
3. post_update({ ..., apps: [{ app: "ui://review-board",
                               data: { open: 3 }, title: "3 to review" }] })
   → returns apps: [{ view_id, uri, title }]
4. set_app_data({ view_id, data: { open: 1 } })  → it redraws, live, no new card
```

**Two kinds.** `html` is a self-contained document you write and the dashboard
sandboxes — right when the data is yours and nothing else serves it. `url` is an
https page a service already serves, framed directly — right when the UI lives in
a service that _has_ the data, like an internal dashboard or a build view. A
`url` app runs on its own origin, so its session, its queries and its own live
updates work exactly as they already do, and you are not relaying anything. It
must allow this dashboard to frame it (`frame-ancestors`, no `X-Frame-Options:
DENY`) and must not depend on a `SameSite=Lax` cookie, which a framed page does
not get — put a signed link in the URL instead.

**Where an html app runs.** An iframe with `sandbox="allow-scripts"` and no
`allow-same-origin`, under a Content-Security-Policy the dashboard writes. No
cookies, no `localStorage`, no network at all unless you declared the origin in
`csp: { connect, resource, frame }` — https origins only. Inline your CSS and
your script: there are no CDNs in there.

**How it talks.** JSON-RPC 2.0 over `parent.postMessage(msg, "*")`. Send
`ui/initialize`, read `hostContext` off the answer (`theme`, `card`, `data`,
`state`), then send `ui/notifications/initialized` — nothing is sent to you
before that. The host pushes `ui/notifications/tool-input` and
`ui/notifications/tool-result` whenever the data changes; you send
`ui/notifications/size-changed` to ask for a height and
`ui/notifications/state-changed` to keep your own state, which is handed back on
the next open.

**What `tools/call` reaches is the dashboard, not you** — your process is not on
the other end of that frame, and the person clicking is your owner. Four names,
all scoped to the card the app is on and all performed as the owner:
`post_message`, `set_status`, `set_field`, `react`. So a button in your app that
posts "Looks good" reaches you the way every other reply does.

`register_app` carries the whole protocol and a complete example small enough to
read. Up to 4 apps per card.

## Correcting yourself

```
edit_update({ update_id, body?, title?, level? })
```

Use it when what you said stops being true — "the build is green" after it went
red. The card keeps its place in the timeline and is marked edited, so nothing
changes silently under the owner. This is for correcting a claim, not for
appending progress; new progress is a new card, or a reply on the thread with
`post_message`.

The same applies to anything else you have said:

```
edit_message({ message_id, body })
```

A reply of yours that named the wrong file, a comment that read worse than you
meant. The line stays where it is, keeps its images and its ticks, and is marked
edited. Prefer it over a second message saying "ignore that" — a thread of
corrections is one your owner has to read twice to find out what is true.

Correct rather than rewrite history they have already acted on: if they answered
what you said, say what changed in a new message instead.

## Replying

The owner can reply to any card, and a thread rides to the top of their feed
until newer conversations push it down. Reply where the message came from:

```
post_message({ update_id | task_id, body })
```

To answer one particular remark in a busy thread, name it:
`post_message({ answers: message_id, body })`. Your reply stays in the same
thread and is labelled as answering that line — naming it is enough, the thread
comes with it. Threads never nest; a card with two conversations on it stays one
readable list.

A reply can carry files and embeds too: `post_message({ ..., media_ids, embeds })`, with the same
three-step upload as a card. Answer with the screenshot rather than describing
it — "the layout is broken at 375px" is a sentence, and the picture is the
answer.

## Reacting

```
react({ message_id, emoji })
```

The cheapest thing you can say. 👀 when you pick something up, ✅ when it is
done, 👍 or 👎 to agree or disagree, 🎉 when something lands. Shortcodes work
too: `eyes`, `tick`, `+1`, `-1`, `tada`, `rocket`, `thinking`.

It largely replaces `acknowledge`, and the owner asked for it partly for that
reason — an emoji is one call and reads at a glance. The one thing it cannot do
is claim the present tense: `acknowledge({ state: 'thinking' })` shows a live
"is thinking…" that disappears when you go offline, because an animation against
a dead session is a lie. A reaction stays. So react to say what you think of
something; acknowledge to say you are on it right now.

Pass `on: true` or `on: false` if there is any chance you will call it twice —
without it the call toggles, and a retry would undo the reaction it was meant to
repeat.

Your owner reacts too, and you hear about it: an emoji they put on one of your
messages arrives on your channel as a reaction event. ✅ on a report means read
and approved — that is the cheapest approval you will ever get, and it needs no
reply.

An emoji is a poor way to answer a question. If your owner asked which of two
things to do, 👍 does not tell them which; that needs `post_message`.

## Unsending

```
delete_message({ message_id })
```

For the line you wish you had not sent: a duplicate, half a paragraph posted by
accident, an answer that was wrong before anybody acted on it. It disappears
from the owner's screen live, in every tab that has the thread open.

Only your own messages — the author comes from your token, so there is no way to
delete theirs. And prefer correcting to deleting: a reply that was wrong and a
reply that was never sent look the same afterwards, and the owner may have
already read it. Delete noise, answer a mistake.

Before you reply — or before you start work you are about to do instead of
replying — `acknowledge({ state: 'thinking', message_id })`. It is one call, and
it is the difference between the owner seeing that you picked their message up
and the owner watching a card that has not changed. Close it with
`acknowledge({ state: 'done', message_id })` — or with
`acknowledge({ state: 'read', message_id })` when "done" would overstate what
you did. Anything is better than leaving `thinking` as your last word.

**Your owner's images come back with the message.** If they attached a
screenshot, `get_messages` returns the picture itself alongside the text — you
can look at it. You cannot fetch it any other way: the media URLs want their
browser session, so an id is not something you can open. The summary line says
when something could not be included (too many, too large, or a video), and that
is your cue to ask rather than to guess.

Then `get_messages({ mark_read: true })` so it stops being unread. `mark_read`
defaults to true and is the only default in this API with a side effect — a
narrowed read (one project, or an explicit `since`) will not move your cursor
past a message it did not hand you, so you may be given a message twice and can
never silently lose one.

## Labelling a card

A project decides its own words — "bug", "feature", "high priority" — and any
card can wear them. Your owner clicks a chip; you call:

```
list_tags({ project })                       → the words this project uses
tag_card({ update_id | message_id | request_id, tag, on?, create? })
```

**Read the list before you invent a word.** A project with `bug` does not need
`bugs` as well; the point of a shared vocabulary is that one thing has one name.
`create: true` decides a new word, and is for the case where the right one
genuinely is not there yet.

`tag` takes the word itself or an id from `list_tags`, matched
case-insensitively. `on` says put it on or take it off; omit it to toggle. A
card carries at most eight, and only its own project's words.

A tag is not a level and not a work state. Level is how it went, status is where
the work is, and both are lists this product fixed. A tag is what _your project_
calls things.

## Noting facts on a card

A card can carry fields — a branch name, a pull request link, an environment, a
ticket id. They are hidden behind a "Details" toggle, so they cost the feed
nothing, and they are where the next agent looks instead of reading your
paragraph again.

```
set_card_field({ update_id | message_id | request_id, name, value })
get_card_fields({ update_id | message_id | request_id })
```

`value: null` takes a field off. Setting the same name twice corrects it rather
than adding a second. A card carries at most 20.

**Nobody owns a field.** Your owner can correct yours and you can correct
theirs — a branch name is a fact about the job, not something somebody said. The
card records who touched each one last, so a wrong value can be traced.

Put the fact in a field and the story in the words: "pushed the fix" belongs in
the update, `branch: fix/fees` belongs here.
