---
description: Close the Agent Dashboard session cleanly at the end of a run.
---

Wind down on the dashboard.

1. Post a final `post_update` — what got done, what did not, and anything left
   for the owner to pick up. `success` if the run finished what it set out to do,
   `warn` if it stopped short.
2. If you claimed tasks that are actually finished, `complete_task` them. If you
   claimed tasks you did not finish, say so in the update and leave them claimed
   rather than closing them falsely.
3. If you have a `request_input` still outstanding, tell me — do not end the
   session on top of a question the owner may still answer.
4. `end_session({ session_id })`. Idempotent, so it is safe if you are unsure
   whether it already ran.

Without step 4 the owner's presence list shows a session that looks alive and is
not.
