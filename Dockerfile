# Multi-stage build for Cloud Run (or any container platform).
#
# The layout mirrors a good Python Dockerfile: install dependencies in a stage
# that gets cached, then copy the result into a slim runtime image that never
# saw a compiler. Two details are specific to a pnpm workspace.
#
# 1. `pnpm fetch` populates the store from the lockfile ALONE. It does not need
#    the source, so this layer only invalidates when the lockfile changes --
#    the equivalent of `COPY uv.lock` before `COPY src/`.
# 2. `pnpm deploy --filter=<pkg>` copies one workspace package plus exactly its
#    dependencies into a flat directory, resolving `workspace:*` links. Without
#    it you either ship the whole monorepo or hand-copy symlinked packages.
#
# There is no compile step, but there IS a loader, and the reason is worth
# knowing. Node's native type stripping refuses to run on files under
# `node_modules` (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING). Locally that
# never fires, because pnpm symlinks workspace packages and the real paths sit
# outside node_modules. `pnpm deploy` copies them in, so the container hits it
# on the first import of `@agent/core`.
#
# So: `node src/index.ts` works on your laptop and not in this image. The two
# ways out are shipping `tsx` (below, one dependency, no build config) or
# adding a real build step with tsdown/tsup and shipping JavaScript. Ship
# JavaScript if a transpiler in the production image bothers you -- it is a
# defensible objection.

# ---------- dependencies ----------
FROM node:24-slim AS deps
WORKDIR /app

RUN corepack enable

# Lockfile and manifests only. Source changes must not bust this layer.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/mcp/package.json apps/mcp/
COPY packages/schemas/package.json packages/schemas/
COPY packages/agent-core/package.json packages/agent-core/
COPY packages/observability/package.json packages/observability/

RUN pnpm fetch --frozen-lockfile

COPY . .
RUN pnpm install --frozen-lockfile --offline

# `--prod` drops devDependencies; `--legacy` produces a plain node_modules tree
# rather than symlinks into a store that will not exist in the next stage.
RUN pnpm deploy --filter=@agent/api --prod --legacy /out

# ---------- runtime ----------
FROM node:24-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production

# Never run as root. `node:*` images already ship a `node` user, so this is
# one line rather than a useradd incantation.
USER node

COPY --from=deps --chown=node:node /out /app

# Cloud Run injects PORT and expects the process to bind it. The Zod schema in
# packages/schemas/src/env.ts reads it; the default only applies locally.
ENV PORT=8080
EXPOSE 8080

# `pnpm deploy` flattens the package, so `apps/api/src/` arrives as `src/`.
#
# No `npm start`, no shell wrapper. `node` becomes PID 1 and receives SIGTERM
# directly, which is what the drain handler in apps/api/src/index.ts needs. An
# `npm start` in between swallows the signal and you get killed connections on
# every deploy.
CMD ["node", "--import", "tsx/esm", "src/index.ts"]
