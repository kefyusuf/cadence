FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund


FROM node:24-bookworm-slim AS test
ENV NODE_ENV=development
WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json tsconfig.json vitest.config.ts ./
COPY --chown=node:node src ./src
COPY --chown=node:node test ./test
USER node
CMD ["npm", "test"]
