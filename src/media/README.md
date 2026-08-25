# `src/media` — upload and derivatives

**One job:** mint and verify upload tokens, ingest bytes safely, produce
derivatives, and own the disk layout.

**May import:** `$db`, `$events`, `$config`.

**Must not:** leak paths. Callers get `ingest()` and `derivativesFor()`; they
never learn where a file lives on disk.

Notes carried from the design (§6):

- Mime allowlist only: png, jpeg, webp, gif, mp4, webm, quicktime. **SVG is
  rejected** — it is a script-execution vector.
- Single-use HMAC upload tokens, 15 minute TTL.
- The byte cap is enforced **as the stream is written**, never by trusting
  `Content-Length`. sha256 for dedup; the real type is sniffed from magic bytes
  and a declared mime that disagrees is rejected.
- Derivative queue at concurrency 2: `sharp` for 640w/1600w webp with EXIF
  stripped, `ffmpeg` for a 1s poster frame plus an h264 mp4 when the source is
  not web-playable. Then flip to `ready` and publish `media.ready`.
- Layout: `data/media/<id[0:2]>/<id>/{original.ext,thumb-640.webp,thumb-1600.webp,poster.jpg,video.mp4}`.
  The raw upload directory is never served.

Public entry point: `src/media/index.ts`.
