# `src/media` — upload and derivatives

**One job:** mint and verify upload tokens, ingest bytes safely, produce
derivatives, and own the disk layout.

**May import:** `$db`, `$events`, `$config`.

**Must not:** leak paths. Callers get `ingest()` and `derivativesFor()`; they
never learn where a file lives on disk.

This is the highest-risk surface in the product: it is the one place a process on
somebody else's machine writes a file on this one.

| File         | Does                                                                      |
| ------------ | ------------------------------------------------------------------------- |
| `mime.ts`    | The allowlist, the kind and extension for each type, magic-byte sniffing. |
| `tokens.ts`  | HMAC sign/verify, the 15 minute TTL, the absolute upload URL.             |
| `paths.ts`   | The disk layout. Internal — nothing here is re-exported.                  |
| `upload.ts`  | `create_upload`: validate the claim, reserve a row, mint the token.       |
| `ingest.ts`  | The PUT: stream, cap, sniff, hash, dedup, place.                          |
| `serve.ts`   | `/media/:id/:variant`: which file, which type, as a stream.               |
| `sweeper.ts` | Garbage-collect media nothing points at.                                  |
| `errors.ts`  | `MediaError` — codes that survive as 403 / 413 / 415 at the route.        |

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
- An uploaded row stays `pending` with its real size and hash. Flipping to `ready`
  and publishing `media.ready` belongs to the derivative slice (§11 step 10):
  `sharp` for 640w/1600w webp with EXIF stripped, `ffmpeg` for a 1s poster frame
  plus an h264 mp4 when the source is not web-playable. `serve.ts` already serves
  those variants the moment rows exist for them.
- The sweeper collects unattached media an hour after it was created — `ready`,
  and also `pending` and `failed`, because an upload token lives fifteen minutes
  so an hour-old reservation can never be completed by anyone. `startMediaSweeper`
  in `$domain` runs it every fifteen minutes, started by `src/hooks.server.ts`.

Public entry point: `src/media/index.ts`. Test fixtures and a throwaway data
directory: `src/media/testing.ts`, imported as `$media/testing`.
