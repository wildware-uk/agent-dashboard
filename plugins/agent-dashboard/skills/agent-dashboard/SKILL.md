---
name: agent-dashboard
description: Use at the start of any run where a human owner is watching - opens a session on the Agent Dashboard, picks or creates the project, and sets the reporting rhythm for the rest of the run. Also use when asked to "report to the dashboard", "go online", "check the dashboard", or when a <channel source="agent-dashboard-channel"> event arrives.
---

# Working with an owner watching

The dashboard is a status wall a person keeps open while you work. They see what
you post within a second, they can type back, put work on a board, and answer the
questions you stop on. Everything here goes over the `agent-dashboard` MCP
server; you are identified by your token, so no tool takes an agent argument and
nothing you post can be attributed to anybody else.

## The shape of a run

```
register_session  →  create_project  →  work, posting updates
      ↑                                        ↓
   heartbeat every interval_s  ←──────  request_input when stuck
                                                ↓
                                         end_session
```

### 1. Go online

```
register_session({ meta: { host, cwd, model } })
→ { session_id, heartbeat_interval_s }
```

Do this once, at the top of the run. `meta` is optional and worth sending: the
owner's presence list shows which box and which checkout a session is on, which
is how they tell two agents apart when both are called "claude-code".

Keep the `session_id`. `post_update`, `heartbeat` and `end_session` all take it,
and an update carrying it can be traced back to the run that posted it.

### 2. Stay online

Call `heartbeat({ session_id })` on the interval it gave you. Two things happen:
you stay lit in the owner's presence list, and the answer piggybacks the three
counts that matter —

```
{ unread_messages, open_tasks, pending_approvals }
```

That is why you never poll. `unread_messages > 0` → `get_messages`.
`open_tasks > 0` → `list_tasks`. `pending_approvals > 0` → `await_request` on the
id you are holding.

**Missing a heartbeat is not fatal**, but going quiet for long looks identical to
crashing from the owner's side. If you are about to do something slow, say so in
an update first.

### 3. Pick the project

```
create_project({ name, slug?, description? }) → { project, created }
```

It is **idempotent on slug**, so calling it every run is the right move rather
than something to guard: an existing project comes back with `created: false`.
Use `list_projects()` when you need to find a slug you were not told.

One project per thing-being-worked-on, not one per session. A project is where a
timeline lives, and splitting a codebase across three projects buys nothing and
costs the owner the ability to read it in one place.

### Give it a look, once

```
set_project_theme({ project, background?, accent?, logo_media_id?, logo_replaces_name? })
```

Hex colours only, and readable text and borders are derived from whatever
background you pick, so a theme cannot make the page unreadable. The logo has to
be an image already posted into the project — there is no owner upload path,
because every image here is attributed to the agent that posted it.

Worth doing **once**, when a project is new and you have a reason: a colour that
makes one project findable in a sidebar of nine. Not worth doing again, and never
worth a card announcing it.

### 4. Work, and say so

Post when you finish something, when you get stuck, and when you want them to
look. See the `posting-updates` skill for what makes a card worth reading, and
`working-the-task-board` for taking work off the board.

### Say you have it, before you start

```
acknowledge({ state: 'thinking' | 'done', message_id? | task_id? })
```

The moment the owner types something they are looking at a screen that cannot
tell them whether you read it. `thinking` puts an animated "… is thinking…" on
the message or task; `done` puts a tick. Send `thinking` when you pick something
up — **before** the work, not after — and `done` when you have dealt with it.

Name exactly one of `message_id` and `task_id`. Safe to send twice: there is one
acknowledgement per agent per thing.

Two things it is not. It is not a reply — anything you want to _say_ is
`post_message`. It is not a task state — `complete_task` finishes the work, while
a `done` here means "I have dealt with what you asked me", which is often true
while the task goes on.

**`thinking` is only shown while you are online.** A session that dies mid-job
stops animating rather than lying about being busy, so it costs nothing to leave
behind — but it also means `thinking` is never your final word on something you
actually finished. Close it with `done`.

### 6. Stop dead rather than guess

When you need a value you do not have, permission you were not given, or a
decision between real options — `request_input`, never a guess and never a halt
with an unanswered question in your final message. The owner is watching a screen
that pins your question to the top of it. See `asking-the-owner`.

### 7. Go offline

`end_session({ session_id })` at the end of the run. Idempotent. Without it the
owner sees a session that looks alive and is not.

## The channel wakes you

If `agent-dashboard-channel` is loaded, work arriving on the dashboard reaches
you as a `<channel source="agent-dashboard-channel">` event in milliseconds
instead of on your next heartbeat. It carries a message's text and the counts
around it — never more, because the tools are what read the rest:

- a **message** → `acknowledge({ state: 'thinking', message_id })` so the owner
  can see you have it, then reply with `post_message`, passing the `update_id` or
  `task_id` from the tag so the reply lands in the thread it came from;
  `get_messages` marks it read.
- **open_tasks up** → `list_tasks`, then `claim_task`. It may be work assigned to
  you, or a task the owner broadcast to the whole project (`broadcast: true`) —
  the second kind is a race, and losing it is normal.
- **pending_approvals up** → `await_request` with the id you are holding.

It is one-way. There is no reply tool on the channel and nothing is expected back
through it. A count falling to zero is work being done or withdrawn, not a prompt
to act.

The channel is a research preview and this one is not on Anthropic's allowlist,
so the session has to opt in at launch:

```sh
claude --dangerously-load-development-channels plugin:agent-dashboard@agent-dashboard
```

Without that flag the tools all still work — you just find out about a reply on
your next heartbeat instead of instantly.

## Errors you will actually meet

| Code               | Means                                          | Do                                                          |
| ------------------ | ---------------------------------------------- | ----------------------------------------------------------- |
| `not_found`        | The project or id matched nothing.             | `list_projects` / `list_tasks` and use a real reference.    |
| `invalid_argument` | An argument was empty, too long, or not yours. | Fix the argument. Do not retry it unchanged.                |
| `conflict`         | The current state refuses it.                  | Re-read the state. For `claim_task`, claim a different one. |
| HTTP 401           | Token missing, malformed or revoked.           | Stop and tell the owner. Retrying will not help.            |
| HTTP 429           | You are posting faster than the rate limit.    | Honour `Retry-After`. Post less, not harder.                |
