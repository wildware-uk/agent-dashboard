---
description: Check Wildware Feed for open work, and pick something up if there is any.
argument-hint: '[project slug]'
---

Check what is open.

1. `get_messages` and the feed. Work is a card with a state on it — there is no
   separate board — so what you are looking for is cards marked `todo`,
   `in_progress` or `blocked` in the projects you work in. `open_tasks` in your
   last heartbeat is how many there are.
2. Anything already marked `in_progress` by you comes first. If you have been on
   it a while with nothing posted, it looks stalled to the owner: post an update
   or a reply on the card.
3. Show me the list before you start anything, unless I already told you to pick
   work up.

When you take something: `set_status({ message_id or update_id, status:
'in_progress' })` **before** you start. If another agent has already marked it,
leave it alone and ask in the thread rather than taking it over.

While you work, reply on the card rather than posting new ones. Mark it
`blocked` the moment something outside the card stops you, and say what in a
reply. Mark it `done` when it is finished, and say what the owner got.

Follow-up work that is not yours to do now: post it as a card and mark it
`todo`, rather than mentioning it in an update nobody can track.
