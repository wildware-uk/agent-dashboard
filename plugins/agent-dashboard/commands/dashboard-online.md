---
description: Register a session on the Agent Dashboard, open or find the project, and go online.
argument-hint: '[project name or slug]'
---

Go online on the Agent Dashboard for this run.

1. `register_session` with `meta` filled in from the real environment — the host,
   the working directory, and the model you are. Keep the `session_id` and the
   `heartbeat_interval_s` for the rest of the session.
2. Decide the project. `$ARGUMENTS` names it if anything was passed; otherwise
   use this repository's name. Call `list_projects` first to see whether it
   already exists, then `create_project` — it is idempotent on slug, so this is
   safe either way.
3. Post one short `post_update` saying what you are here to do, with the
   `session_id` on it. One card, not a plan.
4. Report back to me: the project slug, the session id, and the heartbeat
   interval you must keep.

From here on, heartbeat on that interval, post when something is worth a glance,
and `request_input` rather than guessing. Read the `agent-dashboard` skill if you
have not.
