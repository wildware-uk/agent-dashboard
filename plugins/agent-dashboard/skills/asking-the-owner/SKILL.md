---
name: asking-the-owner
description: Use whenever you need something only the human can supply - a missing value, permission for something consequential, a decision between options, or approval of a draft you are about to send. Covers request_input's six kinds, the await_request wait loop, and why a timeout is not a yes.
---

# Stopping to ask

Three wrong things to do when you are blocked: guess, halt with an unanswered
question in your final message, or do the safe-looking half and report it as
done. `request_input` is the fourth option, and it is the one the dashboard
exists for. The question pins itself to the top of the owner's screen and pushes
a notification to their phone.

Ask when you need:

- a value you do not have (a hostname, a name, a version),
- permission for something consequential or irreversible,
- a decision between options you cannot rank yourself,
- approval of something you are about to send outward.

## Pick the kind by what you need back

| kind           | You get back               | For                                       |
| -------------- | -------------------------- | ----------------------------------------- |
| `text`         | a string                   | a commit message, a name, a missing value |
| `confirm`      | `true` / `false`           | permission for one consequential thing    |
| `buttons`      | one of your `options`      | retry / skip / abort                      |
| `choice`       | one of your `options`      | one item from a list                      |
| `multi_choice` | an array of your `options` | any number, bounded by `min` / `max`      |
| `form`         | `{ action, text }`         | **a draft plus a decision, in one step**  |

`options` is required for `buttons`, `choice`, `multi_choice` and `form`, and
refused for the others. `question` is the one line they read — phrase it so it is
answerable without reading your transcript. `detail` is the paragraph under it:
what you found, what you are about to do, why you stopped.

### `form` is the one worth knowing

A real approval is usually two questions at once. "Here is the Slack message I am
about to send" is both _edit this_ and _decide about it_, and asking them
separately means one of the two gets answered about text that has since changed.

```
request_input({
  kind: 'form',
  question: 'Send this to #eng?',
  options: ['Send', 'Reject'],     // your action buttons
  label: 'Message',                // names the editable field
  default: 'Deploy is going out at 4pm...',   // your draft
  multiline: true
})
```

**Act on `value.text`, never on the draft you sent.** They may have rewritten it,
and `value.action` tells you only what they decided, not what they decided about.
`Reject` is a real answer: send nothing.

## The wait loop — this is the part people get wrong

A human is slower than a tool timeout, so the call does not hold open until they
click. It parks for up to 55 seconds and returns one of four states:

```
{ state: 'answered',  request_id, response: { kind, value }, answered_at }
{ state: 'pending',   request_id, poll_after_ms }
{ state: 'timeout',   request_id }
{ state: 'cancelled', request_id }
```

`pending` means **nobody has answered and you are not finished waiting.**

```
let r = await request_input({ ... });
while (r.state === 'pending') {
  r = await await_request({ request_id: r.request_id });
}
```

Each `await_request` parks for another 55 seconds, so the loop costs almost
nothing while it waits. Stop only on `answered`, `timeout` or `cancelled`.

The wait lives in the dashboard's database, not in the connection. If you crash
mid-wait, call `await_request` with the `request_id` when you come back and you
resume exactly where you were.

## Reading the answer

`response.value` is typed by `response.kind`: a string for `text`, `buttons` and
`choice`; a boolean for `confirm`; an array of strings for `multi_choice`;
`{ action, text }` for `form`.

The server validates every answer against the request that asked for it — a
`choice` is always one of the options you offered, a `multi_choice` always
respects your `min` and `max`. Do not re-validate it.

## A timeout is not a yes

`timeout` means nobody answered in time. `cancelled` means they dismissed the
prompt. **Neither is permission.** Do not do the thing you asked about. Post an
update saying you are blocked and on what, or stop.

`timeout_s` defaults to one hour (5 to 86400). Set it shorter only when a stale
answer would be worse than no answer.

## Say what it is about

Pass `project` (a slug or id) so the banner says what this concerns, and `update`
(an update id) if you just posted the card it follows from — that supplies the
project for you.
