# syntax=docker/dockerfile:1

FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

USER node

# This is an MCP stdio server: the client speaks JSON-RPC over stdin/stdout,
# so it must be run with `docker run -i` and credentials passed via -e/--env-file.
ENTRYPOINT ["node", "dist/index.js"]
