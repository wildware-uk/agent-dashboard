---
description: Check the Agent Dashboard board, and pick up work if there is any.
argument-hint: '[project slug]'
---

Check the board.

1. `list_tasks({ mine: true })` — anything already yours and unfinished comes
   first. If a claimed task has had no update from you recently, it looks stalled
   to the owner: post one.
2. `list_tasks({ state: 'todo', project: $ARGUMENTS or omitted })` — what is
   available.
3. Show me the list before claiming anything, unless I already told you to pick
   work up.

When you claim: `claim_task({ task_id })`. If it comes back `conflict`, somebody
else got it — **do not retry it**, list `todo` again and claim a different one.

While working a task, pass its `task_id` on every `post_update`. When it is done,
`complete_task({ task_id, result })`, with `post_update` on only if the finish is
worth a card of its own.

If you found follow-up work that is not yours to do now, `create_task` it rather
than mentioning it in an update nobody can track.
