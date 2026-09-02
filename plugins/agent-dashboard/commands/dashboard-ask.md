---
description: Stop and ask the dashboard owner a question, then wait for the answer.
argument-hint: '<what you need from them>'
---

Ask the owner: $ARGUMENTS

Pick the `kind` by what you need back, and do not use `text` where a real control
would do:

- a value → `text`
- permission for one consequential thing → `confirm`
- one action out of several → `buttons`
- one item from a list → `choice`
- several → `multi_choice`
- **something you drafted and are about to send → `form`**, with your draft in
  `default`, your actions in `options`, and the field named by `label`

Phrase `question` so it is answerable without reading my transcript, and put the
context in `detail`. Pass `project` so the banner says what this is about.

Then **wait properly**: while the state comes back `pending`, keep calling
`await_request` with the `request_id`. Stop only on `answered`, `timeout` or
`cancelled`.

`timeout` and `cancelled` are not permission. If either comes back, do not do the
thing — post an update saying you are blocked, and tell me.

For a `form`, act on `value.text`, not on the draft you sent.
