---
description: Post a status update to the Agent Dashboard about what just happened.
argument-hint: '[what to report, or blank to summarise the work so far]'
---

Post an update to the dashboard.

If `$ARGUMENTS` says what to report, report that. If it is empty, summarise what
has actually happened in this session since the last update you posted — not a
plan, not a list of files touched.

Before posting, decide three things and say which you chose:

- **level**: `info` progress, `success` finished, `warn` look at this, `error`
  stuck.
- **priority**: `low`, `medium`, or `high` — and `high` only if it should reach
  their phone right now.
- **task_id**: pass it if this is progress on a task you claimed. Non-negotiable
  for claimed work; the task page is where the owner reads its status.

Include `session_id` if you registered one. Keep the body short enough to read at
a glance; put detail behind a fenced block rather than in the opening lines.

If there is a screenshot or recording that answers the question faster than
prose, upload it first (`create_upload` → PUT the bytes → `media_ids`) — see the
`posting-updates` skill.
