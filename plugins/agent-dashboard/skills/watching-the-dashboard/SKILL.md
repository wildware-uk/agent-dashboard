---
name: watching-the-dashboard
description: Use at the start of a run when the agent-dashboard-channel tools are NOT in this session - it starts a background monitor so replies, tasks and answers reach you in seconds instead of on your next heartbeat. Also use when asked to "watch the dashboard", "listen for replies", or when told the channel is off.
---

# Hearing the owner without a channel

The channel is the good version of this: it pushes a structured event into your
session the instant something lands. But it is a research preview, and a session
only gets one if it was launched with
`--dangerously-load-development-channels` — so most sessions do not have it, and
in those the first you hear of a reply is your next `heartbeat`, up to half a
minute later.

The monitor is the fallback, and it needs no flag.

## Do you need it?

**Check whether you already have the channel.** If tools from
`agent-dashboard-channel` are in this session, or `<channel>` events have
arrived, you have it — **stop here.** Running both means every reply arrives
twice, and being interrupted twice for one thing is worse than being interrupted
late.

If there is no channel, invoke this skill. That is all it takes: the monitor is
declared `on-skill-invoke`, so dispatching this skill starts it, and Claude Code
keeps it running for the rest of the session.

## What it does

It holds one connection to `/api/agent/stream` — the same stream the channel
reads — and writes a line whenever something arrives. Every line becomes a
notification in your session.

You will see things like:

```
Your owner on Agent Dashboard: have a look at the migration test
2 open tasks
1 open task, 1 waiting on you
```

**Only rises are announced.** A count falling to zero is you clearing your own
inbox, not a reason to go and look.

## What to do when a line arrives

The line is the news; the tools are the detail. This is one-way — there is no
replying to a notification.

| Line says                | Do                                                                                                                                        |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| a message, with its text | `acknowledge({ state: 'thinking', message_id })`, then `get_messages` to read it properly and mark it read, then `post_message` to answer |
| open tasks               | `list_tasks`, then `claim_task` for anything you are taking                                                                               |
| waiting on you           | `await_request` with the `request_id` you are holding                                                                                     |
| your owner answered      | act on it — the answer is in the line; `await_request` re-reads the typed value in full                                                   |

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
session is for. Inside the plugin those come from your `/plugin` settings, via a
file the `SessionStart` hook writes for it. Run `/dashboard-check` if the tools
are not working either — that is the same configuration.
