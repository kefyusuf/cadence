FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund


FROM node:24-bookworm-slim AS test
ENV NODE_ENV=development
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json vitest.config.ts ./
COPY src ./src
COPY test ./test
USER node
CMD ["npm", "test"]
