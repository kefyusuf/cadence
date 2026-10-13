FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund


# What the published package needs at runtime. There are no runtime dependencies yet, and this
# stage proves it with `npm ci --omit=dev` rather than with a comment: the install leaves no
# node_modules behind at all, so the mkdir is what makes the COPY below a stable contract — when
# week 4 adds Fastify the directory arrives populated and nothing here has to change.
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


FROM node:24-bookworm-slim AS test
ENV NODE_ENV=development
WORKDIR /app
RUN chown node:node /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json tsconfig.json tsconfig.build.json vitest.config.ts eslint.config.js .dependency-cruiser.cjs README.md ./
COPY --chown=node:node src ./src
COPY --chown=node:node test ./test
COPY --chown=node:node scripts ./scripts
USER node
CMD ["npm", "test"]


# dist and the self-check only, built from the stages above. Everything here is root-owned on
# purpose: the runtime user reads the code it executes and cannot rewrite it, which is also why
# the container runs with --read-only in compose and in CI.
FROM node:24-bookworm-slim AS prod
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=deps-prod /app/node_modules ./node_modules
COPY package.json README.md ./
COPY scripts/selfcheck.mjs ./scripts/
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["node", "scripts/selfcheck.mjs"]
CMD ["node", "scripts/selfcheck.mjs"]
