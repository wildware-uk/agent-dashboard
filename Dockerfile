# Agent Dashboard (design §10).
#
# One process, one SQLite file, one data directory. Nothing external, so the
# image is the whole product and the only state is the volume mounted at /data.
#
# Build stage compiles what needs compiling; the runtime stage keeps only
# production dependencies, the built server, the built CLI, and ffmpeg.

# ── build ─────────────────────────────────────────────────────────────────────
FROM node:22-slim AS build

# better-sqlite3, argon2 and sharp all ship prebuilt binaries for glibc x64/arm64
# and fall back to compiling from source when there is no prebuild for the
# platform. The toolchain is here so that fallback works instead of failing the
# build on a machine we did not anticipate; it is left behind in this stage.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates python3 make g++ \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /app

# devDependencies include Playwright, whose install script would otherwise pull a
# browser bundle into a layer that only ever runs `vite build`.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Two entry points into the same code: `build/index.js` is the server and
# `build/cli.js` is the operator CLI, which has to exist before anyone can log in
# (it mints the first agent token and hashes the admin password).
RUN npm run build && npm run build:cli

# Drop devDependencies from the tree the runtime stage copies. The native
# packages keep the bindings they just built.
RUN npm prune --omit=dev


# ── runtime ───────────────────────────────────────────────────────────────────
FROM node:22-slim

# ffmpeg is a system dependency, not an npm one: the derivative pipeline shells
# out to ffmpeg and ffprobe for poster frames and h264 transcodes (design §6).
# Without it every video upload lands and then fails to produce a playable file.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates ffmpeg \
	&& rm -rf /var/lib/apt/lists/* \
	&& ffmpeg -version | head -1

WORKDIR /app

ENV NODE_ENV=production
# The documented default (design §12). The reverse proxy in front points here.
ENV PORT=8010
# Inside the image the data directory is always the mount point; the compose file
# puts a named volume on it. Everything else — the secrets, the public URL — has
# no default anywhere, so a deployment that omits one aborts at startup with the
# variable named rather than booting insecure.
ENV DATA_DIR=/data
# adapter-node rejects bodies over this *before* any route runs, and its own
# default of 512K would 413 every upload with an error the app never sees. Must
# stay >= MAX_VIDEO_BYTES; startup refuses if it is smaller.
ENV BODY_SIZE_LIMIT=209715200

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY --from=build /app/package.json ./package.json

# `mint-token <name>` as an actual command, because that is what the README tells
# a stranger to run and `docker compose exec dashboard mint-token laptop` should
# be the whole of it.
RUN printf '#!/bin/sh\nexec node /app/build/cli.js "$@"\n' > /usr/local/bin/agent-dashboard \
	&& printf '#!/bin/sh\nexec node /app/build/cli.js mint-token "$@"\n' > /usr/local/bin/mint-token \
	&& printf '#!/bin/sh\nexec node /app/build/cli.js hash-password "$@"\n' > /usr/local/bin/hash-password \
	&& chmod +x /usr/local/bin/agent-dashboard /usr/local/bin/mint-token /usr/local/bin/hash-password

# The volume is created by Docker on first run and must be writable by the
# process, which is not root.
RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 8010
VOLUME ["/data"]

# The login page renders without a session and without a database, so it answers
# even on a deployment that is not configured yet — which is what a health check
# should report on: the process is up and serving.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
	CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8010)+'/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "build"]
