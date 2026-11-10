# syntax=docker/dockerfile:1

# ==============================================================================
# Tunaxa CRM - production image
# ==============================================================================
# Two stages, with the boundary at "does the runtime need this file":
#
#   deps    full install from the lockfile, the only place the frontend is built
#   runner  production dependencies plus built assets, running as the `node` user
#
# Nothing from the host's node_modules, .git, .env or test tree reaches the image;
# see .dockerignore, which is where those exclusions actually live.
# ==============================================================================


# ------------------------------------------------------------------------------
# deps: install everything and build the frontend
# ------------------------------------------------------------------------------
FROM node:22-alpine AS deps

WORKDIR /app

# Dependencies first, in their own layer. As long as the manifests are unchanged
# this layer is reused from cache, so an edit to backend/ does not reinstall
# 700+ packages. There is no web/package.json: this is a single-package repo, so
# the root manifests are the whole dependency graph.
COPY package.json package-lock.json ./

# Plain `npm ci`, deliberately not --ignore-scripts.
# The frontend build in this stage runs Vite, which needs esbuild, and esbuild
# resolves its platform binary from its own install script. --ignore-scripts
# installs it without that binary and `vite build` then fails at runtime, so the
# flag would trade a real build for a marginal hardening win on a stage whose
# output is already reduced to production dependencies by the prune below.
# --no-audit/--no-fund keep the layer from phoning home.
RUN npm ci --no-audit --no-fund

# Supply the two native build-time binaries that `npm ci` above cannot.
#
# package-lock.json was generated on Windows, and it records only the platform
# variants for the machine that wrote it: @rollup/rollup-win32-x64-{gnu,msvc}
# and @esbuild/win32-x64. The Linux and musl variants - the ones Alpine needs -
# are absent from the lockfile entirely. `npm ci` installs the lockfile exactly
# and will not resolve anything the lockfile does not name, so after it finishes
# node_modules/@rollup and node_modules/@esbuild are both empty directories and
# `npm run build` dies with
#   Cannot find module @rollup/rollup-linux-x64-musl
# which is npm/cli#4828. Nothing in the image is misconfigured; the lockfile is
# simply platform-scoped to Windows.
#
# Regenerating the lockfile on Linux would fix it too, but that rewrites a
# committed file shared with every Windows developer, and these two packages
# exist only to compile the frontend in this throwaway stage - they are dropped
# again by the prune below. So they are added here instead.
#
# The versions are read from the packages rollup and esbuild just installed
# rather than written out, so this cannot drift from the lockfile: bump either
# dependency and the matching binary follows automatically.
#
# --no-save keeps npm from persisting the addition to package.json, and install
# scripts are left enabled because esbuild's own install step is what places
# its binary where the resolver looks for it.
RUN npm install --no-save --no-audit --no-fund \
      "@rollup/rollup-linux-x64-musl@$(node -p "require('./node_modules/rollup/package.json').version")" \
      "@esbuild/linux-x64@$(node -p "require('./node_modules/esbuild/package.json').version")"

# Source. The .dockerignore strips node_modules, .git, .env and the test tree, so
# what lands here is the application itself.
COPY backend ./backend
COPY web ./web
COPY run-migrations.js ./

# `npm run build` is `vite build --config web/vite.config.ts`, which outputs to
# web/dist. backend/server.js serves that directory as static files and falls
# back to its index.html for client-side routes, so the UI and the API come from
# one origin and no CORS or proxy layer is needed in production.
RUN npm run build

# Drop devDependencies in place rather than doing a second install. The result is
# a node_modules containing only what the runner needs, which is what gets copied
# forward. npm prune rewrites the tree, it does not re-run install scripts.
RUN npm prune --omit=dev


# ------------------------------------------------------------------------------
# runner: production runtime
# ------------------------------------------------------------------------------
FROM node:22-alpine AS runner

# wget comes from busybox and is already present; the healthcheck below relies on
# it rather than adding curl to the image.
WORKDIR /app

# tini is installed here, not in the build stage. It has to be in the stage that
# actually runs the server: each stage starts from a clean base image, so a
# package added in deps would not exist in runner and the entrypoint below would
# fail with "no such file or directory".
#
# It gives the container a real PID 1 that forwards SIGTERM. backend/server.js
# installs its own SIGTERM handler to stop the email, transcription and report
# scheduler workers, and without an init shim that handler never runs - Docker
# would SIGKILL the process after its grace period instead. The cost is one
# ~20 KB package in the runtime image, which is cheaper than losing in-flight
# work on every deploy and every rolling restart.
RUN apk add --no-cache tini

# PORT selects the published port. HOST is what makes EXPOSE meaningful:
# backend/server.js defaults to 3001 on 127.0.0.1, which is right for the dev
# workflow (start.js and the Vite proxy in web/vite.config.ts both target that)
# and wrong for a container, because a server bound to loopback inside a
# container cannot be reached through a published port. Only this stage
# overrides either value, so local development is unchanged.
#
# One instruction, with the backslashes kept clear of any comment line. A
# comment between two continuations is easy to misread as ending the
# instruction, and getting it wrong changes the resulting environment.
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

# Only production dependencies cross the stage boundary.
COPY --from=deps --chown=node:node /app/node_modules ./node_modules

# Application source and the built frontend.
#
# The frontend bundle is copied from the build stage, not from the build context.
# `npm run build` above is what produces web/dist, and .dockerignore excludes
# dist/ precisely so a stale host build never gets sent to the daemon - copying
# from the context would look for a directory the context does not contain and
# fail the build. Copying from deps also guarantees the served assets are the
# ones just built, from the same dependency tree.
COPY --chown=node:node package.json ./
COPY --chown=node:node run-migrations.js ./
COPY --chown=node:node backend ./backend
COPY --from=deps --chown=node:node /app/web/dist ./web/dist

# --chown above is the whole permission story: it sets node:node as owner while
# the files are being written, so there is no window in which /app is root-owned
# and no separate chmod pass. node is uid/gid 1000 in the official image.

# Documented so the published port and the listening port are stated once.
EXPOSE 3000

# /api/health is registered in backend/routes/auth.js and answers { ok: true }.
# start.js already polls this endpoint, so the container healthcheck and the
# existing dev launcher agree on what "ready" means.
#   wget uses short flags because the busybox build in node:22-alpine is what
#   provides it; curl would mean adding a package to the runtime image.
#   --start-period 15s covers boot: cache init and worker startup all run before
#   the first listen callback.
#   --retries 3 with a 30s interval means roughly 90s of continuous failure
#   before the container is marked unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:3000/api/health || exit 1

# Drop root before the entrypoint. This is the last statement that needs
# privileges, so nothing after it runs as uid 0.
USER node

# tini as PID 1 so SIGTERM reaches the shutdown handler in backend/server.js and
# the BullMQ, email and transcription workers get to close their connections.
# exec form, so Node becomes PID 2 and receives signals directly.
#
# backend/server.js, not the root start.js: start.js is the development launcher
# and spawns both the API and a Vite dev server on separate ports. In a
# production image the frontend is already built and served by the API process.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "backend/server.js"]
