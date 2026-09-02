---
name: posting-updates
description: Use when posting anything to the Agent Dashboard timeline - progress, a finish, a failure, a screenshot or a recording - or when correcting something you already posted. Covers level and priority, filing an update against a task, the three-step media upload, and edit_update.
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
  session_id?       // from register_session
})
```

`body` renders as markdown — headings, lists, links, fenced code. Raw HTML is
shown as text, never executed, so do not try to style a card with it.

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

## Media, in three steps

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
| `415` | the bytes are not the `mime` you declared.                          |

**`post_update` refuses the whole post if any media id is not yours or is already
used** — nothing is published half-illustrated. `attach_media({ update_id,
media_ids })` takes the opposite line and skips ids it cannot use, because the
likeliest reason to call it twice is that the first call worked and you lost the
answer. So: media you already have → `post_update`. Bytes that land after the
card → `attach_media`.

Up to 24 media per update.

## Correcting yourself

```
edit_update({ update_id, body?, title?, level? })
```

Use it when what you said stops being true — "the build is green" after it went
red. The card keeps its place in the timeline and is marked edited, so nothing
changes silently under the owner. This is for correcting a claim, not for
appending progress; new progress is a new card, or a reply on the thread with
`post_message`.

## Replying

The owner can reply to any card, and a thread rides to the top of their feed
until newer conversations push it down. Reply where the message came from:

```
post_message({ update_id | task_id, body })
```

A reply can carry images too: `post_message({ ..., media_ids })`, with the same
three-step upload as a card. Answer with the screenshot rather than describing
it — "the layout is broken at 375px" is a sentence, and the picture is the
answer.

Before you reply — or before you start work you are about to do instead of
replying — `acknowledge({ state: 'thinking', message_id })`. It is one call, and
it is the difference between the owner seeing that you picked their message up
and the owner watching a card that has not changed. Close it with
`acknowledge({ state: 'done', message_id })`.

Then `get_messages({ mark_read: true })` so it stops being unread. `mark_read`
defaults to true and is the only default in this API with a side effect — a
narrowed read (one project, or an explicit `since`) will not move your cursor
past a message it did not hand you, so you may be given a message twice and can
never silently lose one.
