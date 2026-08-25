# `src/media` — upload and derivatives

**One job:** mint and verify upload tokens, ingest bytes safely, produce
derivatives, and own the disk layout.

**May import:** `$db`, `$events`, `$config`.

**Must not:** leak paths. Callers get `ingest()` and `derivativesFor()`; they
never learn where a file lives on disk.

This is the highest-risk surface in the product: it is the one place a process on
somebody else's machine writes a file on this one.

| File          | Does                                                                      |
| ------------- | ------------------------------------------------------------------------- |
| `mime.ts`     | The allowlist, the kind and extension for each type, magic-byte sniffing. |
| `tokens.ts`   | HMAC sign/verify, the 15 minute TTL, the absolute upload URL.             |
| `paths.ts`    | The disk layout. Internal — nothing here is re-exported.                  |
| `upload.ts`   | `create_upload`: validate the claim, reserve a row, mint the token.       |
| `ingest.ts`   | The PUT: stream, cap, sniff, hash, dedup, place.                          |
| `serve.ts`    | `/media/:id/:variant`: which file, which type, as a stream.               |
| `queue.ts`    | The in-process job queue: two at a time, and a failure is a value.        |
| `ffmpeg.ts`   | The `ffmpeg` / `ffprobe` wrappers, and what counts as web-playable.       |
| `derive.ts`   | One media item: thumbnails, poster, transcode, status, `media.ready`.     |
| `pipeline.ts` | Which media gets derived and when: the backlog pass and the worker.       |
| `sweeper.ts`  | Garbage-collect media nothing points at.                                  |
| `errors.ts`   | `MediaError` — codes that survive as 403 / 413 / 415 at the route.        |

Notes carried from the design (§6):

- Mime allowlist only: png, jpeg, webp, gif, mp4, webm, quicktime. **SVG is
  rejected** — it is a script-execution vector. It is not "not implemented yet";
  `index.test.ts` asserts it stays out.
- Single-use HMAC upload tokens, 15 minute TTL. The signature stops an id being
  guessed; **single use is enforced by the database** (`consumeUploadToken` is
  one conditional UPDATE), because a signature cannot express "already spent".
- The byte cap is enforced **as the stream is written**, never by trusting
  `Content-Length` — an oversized header is refused without reading a byte, and
  an oversized body is cut off mid-flight. sha256 for dedup; the real type is
  sniffed from the first 4100 bytes, which are held in memory and only written
  once they agree with the type the token authorised. A zip renamed `.png` and an
  SVG therefore never reach the disk at all.
- Identical bytes are stored once: the second upload **hard-links** the first
  file, so each media row stays independently addressable and independently
  deletable while the bytes exist once.
- Layout: `data/media/<id[0:2]>/<id>/{original.ext,thumb-640.webp,thumb-1600.webp,poster.jpg,video.mp4}`.
  In-progress uploads live in `data/tmp/uploads/`, **outside** the served tree, so
  the raw upload directory is unreachable by construction rather than by a
  filename check.
- An uploaded row stays `pending` with its real size and hash. Flipping it to
  `ready` and publishing `media.ready` is the derivative pipeline's job (§11 step
  10): `sharp` for 640w/1600w webp with EXIF stripped, `ffmpeg` for a poster frame
  at one second plus an h264 mp4 when the source is not web-playable. `serve.ts`
  serves those variants the moment rows exist for them.
- **Work is found in the table, not handed over by the upload.** The worker lists
  rows that are still `pending` with bytes on disk and submits them. That is why
  media uploaded before this slice existed is derived too, and why a restart
  mid-transcode resumes instead of losing the item. `processMedia` skips a row
  that is already `ready`, and the queue folds repeat submissions of one id into
  the run in flight, so `media.ready` fires **exactly once per media**.
- A **thumbnail row's width is also its address** — `/media/:id/thumb-640` finds
  its file by `(kind, width)` — so thumbnails are resized to exactly 640 and 1600
  pixels wide, enlarging a smaller source rather than recording a width that would
  be a lie about the file and about the address.
- A failure sets `status = 'failed'` and writes the decoder's own complaint to
  `error.txt` beside the bytes, because `media` has no column for a reason. No row
  names that file, so `/media/:id/:variant` cannot serve it; read it back with
  `readMediaFailure(settings, id)`.
- The sweeper collects unattached media an hour after it was created — `ready`,
  and also `pending` and `failed`, because an upload token lives fifteen minutes
  so an hour-old reservation can never be completed by anyone. `startMediaSweeper`
  in `$domain` runs it every fifteen minutes, started by `src/hooks.server.ts`.

## Running the derivative pipeline

`src/hooks.server.ts` calls `startDerivativeWorker()` at boot, and that is the
whole of the normal path: within a second of an upload landing, and within a
second of the server starting, everything `pending` with bytes on disk is queued.
**A deployment that upgraded into this slice with a backlog needs nothing but a
restart** — the first tick finds every one of those rows.

To drain a backlog explicitly instead, from a maintenance script or a test:

```ts
import { getDatabase } from '$db';
import { mediaSettings, processPendingMedia, readMediaFailure } from '$media';

const settings = mediaSettings();
const result = await processPendingMedia(settings, { db: getDatabase(), limit: 500 });
// { submitted: 9, ready: 8, failed: 1, skipped: 0 }
await readMediaFailure(settings, someFailedId); // why the one failed
```

It resolves when the work is done, never rejects for a bad file, and is safe to
run while the worker is also running: the same "one run per media id" rules apply,
so at worst a row is looked at twice and skipped the second time. A `failed` row
is terminal — the worker will not retry it — so a fixed file is reprocessed with
`processMedia(settings, { db, id, force: true })`.

Public entry point: `src/media/index.ts`. Test fixtures and a throwaway data
directory: `src/media/testing.ts`, imported as `$media/testing`.
