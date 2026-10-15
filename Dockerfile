FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund


# What the published package needs at runtime: `fastify`, and nothing else. The claim is proven by
# `npm ci --omit=dev` rather than by a comment — a dev tool cannot reach a container through this
# stage. The mkdir is kept because the COPY below is a contract: if the runtime list ever goes back
# to empty, the build still has a directory to copy and the image still says so honestly.
FROM node:24-bookworm-slim AS deps-prod
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && mkdir -p node_modules


# The build happens inside the image: prod never ships a directory the host produced.
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build


# The copy list is the package surface `verify:package` measures, so it has to carry the LICENSE: npm
# packs a root LICENSE whether `files` names it or not, and an image that omits it would verify a
# 106-file tarball while the host and CI's checkout pack 107.
FROM node:24-bookworm-slim AS test
ENV NODE_ENV=development
WORKDIR /app
RUN chown node:node /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json tsconfig.json tsconfig.build.json vitest.config.ts eslint.config.js .dependency-cruiser.cjs README.md LICENSE ./
COPY --chown=node:node src ./src
COPY --chown=node:node test ./test
COPY --chown=node:node scripts ./scripts
USER node
CMD ["npm", "test"]


# dist, the runtime dependency and the self-check only, built from the stages above. Everything here is
# root-owned on purpose: the runtime user reads the code it executes and cannot rewrite it, which is also
# why the container runs with --read-only in compose and in CI.
FROM node:24-bookworm-slim AS prod
ENV NODE_ENV=production
# The one place the bind address is not loopback. Inside a container `127.0.0.1` is reachable only from
# the container itself, so a service that is meant to be published has to answer on every interface and
# let the runtime decide which of them is exposed — `compose.yaml` maps it to the host's loopback.
ENV HOST=0.0.0.0
ENV PORT=3000
EXPOSE 3000
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=deps-prod /app/node_modules ./node_modules
COPY package.json README.md ./
COPY scripts/selfcheck.mjs ./scripts/
USER node

# The package surface is proven while the image is built, because the command the container runs is now
# the service rather than the proof: this exits non-zero, and fails the build, if `import('cadence')` does
# not resolve by its published name, if dev tooling reached the runtime layer, or if a DST gap resolves to
# the wrong instant. It runs as the runtime user, so a file the `node` user could not read is a build
# failure rather than a container that starts and then cannot serve.
RUN node scripts/selfcheck.mjs

# An HTTP probe, not a process check: the service is healthy when the route the load balancer would call
# answers. Shell form because the port comes from the environment above, and node's global fetch because
# this image installs no curl.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||'3000')+'/healthz').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/server/main.js"]
