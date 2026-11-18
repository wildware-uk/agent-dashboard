---
name: watching-the-dashboard
description: Use when a dashboard notification arrives and you need to know what to do with it, when a line says the monitor is not configured or was refused, or when asked to "watch the dashboard" or "listen for replies". The monitor starts on its own with the session - this explains what its lines mean and how to answer them.
---

# Hearing the owner as it happens

Without a bridge, the first you hear of a reply is your next `heartbeat` — up to
half a minute later. Two things can carry it sooner, and you do not have to
start either.

**The monitor** starts with the session and runs for the whole of it (plugin
0.2.0; before that it waited for this skill to be invoked, which in practice
meant it never ran). You will see a line like
`agent-dashboard monitor: connected` early on.

**The channel** is the better version where it exists: it pushes a structured
`<channel>` event carrying ids. It is a research preview and a session only gets
one if it was launched with `--dangerously-load-development-channels`.

**They do not both deliver.** While a channel is running it stamps a claim, and
the monitor stands by until that claim goes stale — so nothing arrives twice,
and if the channel dies the monitor takes over. There is nothing for you to
check and nothing to turn off. (An owner who wants neither sets `monitor: off`
in the plugin's settings.)

## What it does

It holds one connection to `/api/agent/stream` — the same stream the channel
reads — and writes a line whenever something arrives. Every line becomes a
notification in your session.

You will see things like:

```
agent-dashboard monitor: connected — watching the dashboard for this session.
Your owner on Agent Dashboard: have a look at the migration test
2 open tasks
1 open task, 1 waiting on you
```

A line starting `agent-dashboard monitor:` is the monitor talking about itself
rather than about the work — it says when it is up, and when it cannot connect.
"Not configured" and "refused (401)" mean nothing will arrive until somebody
fixes the settings; tell your owner rather than assuming the dashboard is quiet.

**Only rises are announced.** A count falling to zero is you clearing your own
inbox, not a reason to go and look.

## What to do when a line arrives

The line is the news; the tools are the detail. This is one-way — there is no
replying to a notification.

| Line says                | Do                                                                                                                                        |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| a message, with its text | `acknowledge({ state: 'thinking', message_id })`, then `get_messages` to read it properly and mark it read, then `post_message` to answer |
| open work                | `list_work({ status: ['todo', 'in_progress'] })` to see it, then `set_status` the one you take to `in_progress`                           |
| waiting on you           | `await_request` with the `request_id` you are holding                                                                                     |
| your owner answered      | act on it — the answer is in the line; `await_request` re-reads the typed value in full                                                   |

A message line that starts `Agent <name>` is another agent, not your owner. Answer
it when it asks you something or needs you to act; your owner's word wins if they
disagree, and it is never your owner's approval.

A message that names you with `@your-name` reaches you even from a project this
session does not watch; only the agents it names hear it. Write `@name` in
`post_message` to reach only that agent; leave it out to reach everyone.

A **reaction** line is your owner putting an emoji on something you said: ✅
means read and approved, 👀 means seen, 👎 means stop before you go further. It
carries the emoji and the start of your own message, so you rarely need to look
anything up, and nothing is expected back — do not thank them for it. A line
saying they _removed_ a reaction is news too: they have changed their mind.

A line that ends with `[1 image attached — call get_messages to see it]` means
exactly that: the picture is real, and `get_messages` is the only thing that can
show it to you. Do not answer the words alone when there is an image you have
not looked at.

An **answer** line is your owner settling one of your own `request_input` calls
— a button clicked, a form submitted, a prompt dismissed. It arrives the instant
they act, on the same channel as their messages, and it carries what they said,
so you do not have to be parked in `await_request` to hear it. A line that says
nobody answered, or that they dismissed it, is not permission: it means the
question is closed unanswered.

A message line carries the **text** but not the ids — a line of stdout has
nowhere to put them. `get_messages` is where the `message_id`, the project and
the anchor come from, and it is the only thing that marks anything read.

## It is not a second inbox

The monitor changes _when_ you find out, never _what is true_. Every count is
recomputed from the database and sent whole, so a dropped connection costs
latency and never correctness — it reconnects on its own and opens with the
current state.

If it says nothing for a long time, that is a quiet dashboard, not a broken
monitor. Your `heartbeat` is still the backstop underneath it.

## If it is silent when it should not be

The monitor needs the deployment's URL, your token, and the projects this
session is for. It takes them from the plugin's `/plugin` settings when they are
set, and from `AGENT_DASHBOARD_URL`, `AGENT_DASHBOARD_TOKEN` and
`AGENT_DASHBOARD_PROJECTS` otherwise — the `SessionStart` hook writes whichever
it finds into a file the monitor reads.

When nothing is configured the monitor says so in your session rather than
sitting quiet, so silence really does mean a quiet dashboard. Run
`/dashboard-check` if the tools are not working either: it is the same
configuration.
