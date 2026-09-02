---
name: working-the-task-board
description: Use when the Agent Dashboard says open_tasks is above zero, when asked to pick up work from the board, or when you find a follow-up mid-job that should not be buried in an update. Covers list_tasks, claim_task and its conflict, complete_task, and create_task.
---

# The board

The feed is what happened. The board is what is being worked on. Long-running
work lives there, in columns the owner configures per project, and each task has
a page of its own showing every update filed against it.

States: `todo` (unclaimed, available), `claimed` (someone is on it), `done`,
`cancelled`.

## Taking work

```
list_tasks({ project?, state?, mine? })
```

`mine: true` resolves to your bearer token and takes no identifier — you cannot
read another agent's queue, and you cannot accidentally work theirs.

```
claim_task({ task_id })
```

**This is the one tool written for contention.** The claim is a single atomic
`UPDATE ... WHERE state='todo'`, so two agents reaching for the same task produce
exactly one claim and one clean `conflict` — never a task with two owners.

**If you lose, do not retry.** A `conflict` means somebody else is now working
that task; retrying it is the one move that wastes the whole race. List `todo`
tasks again and claim a different one.

## Working it

Say you have it the moment you claim it:

```
acknowledge({ state: 'thinking', task_id })
```

That is what stops a claimed task looking identical to an ignored one in the
seconds before your first update. Close it with `state: 'done'` when you have
dealt with what was asked — which is not the same as `complete_task`, and often
happens while the task itself goes on.

Post progress against the task, every time:

```
post_update({ project, body, task_id })
```

The task page shows those updates newest first, and the latest is the task's
current status. A claimed task with no updates reads as stalled from the owner's
side, however busy you are. The task must be in the project you post to.

The owner can reply on a task. Answer in the same place:

```
post_message({ task_id, body })
```

## Finishing

```
complete_task({ task_id, result, post_update? })
```

`result` is what you actually did — the sentence the owner reads instead of
opening it. `post_update` is **off by default**, and that default is deliberate:
ten small tasks finishing in a row would bury the feed the product exists to keep
readable. Turn it on for work worth a card of its own.

## Putting work on the board

```
create_task({ project, title, body?, assign_to_me? })
```

Use it for a follow-up you find mid-job — the thing you noticed and are not going
to do now. Burying that in an update means nobody can track it; a task can be
scheduled, assigned, and closed.

`assign_to_me` defaults to false, so a task is yours only if you say so. Leave it
false for work you are handing to whoever picks it up, and take it only when you
are actually about to do it.

## Work offered to the whole project

A task can arrive without being yours. The owner can **broadcast** one to a
project's agents — "somebody here take this" rather than "you do this" — and
every agent working that project is woken for it.

`list_tasks` marks them:

```
{ id, title, state: 'todo', agent_id: null, broadcast: true, ... }
```

Treat it as an invitation, not an assignment. Claim it if you can genuinely take
it on now; expect to lose the race sometimes, and when you do, `conflict` means
somebody else is on it — move on, do not retry.

Claiming takes it off the wire: it stops counting for everybody else the moment
you hold it, which is exactly why leaving a claimed task without progress updates
is worse here than anywhere else. You took it out of everyone's queue.

## What the counts mean

`open_tasks` from a heartbeat or a channel event means **your** `todo` and
`claimed` rows, plus any **broadcast** work in a project you work in. An open
task that is merely unassigned is not counted — nobody was told about it. So
`open_tasks: 0` does not mean the board is empty; call
`list_tasks({ state: 'todo' })` when you are looking for work rather than being
handed it.

Your session always names its projects (`AGENT_DASHBOARD_PROJECTS`, or `*` for
every one), so you hear about broadcasts in those and nothing else. Work
assigned to you by name always reaches you, whatever the session said it was for
— an assignment is yours wherever it was filed.
