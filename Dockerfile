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

# Only used when TRANSPORT=http; ignored (and no port opened) for the default stdio mode.
EXPOSE 3000

# Transport defaults to stdio (JSON-RPC over stdin/stdout, run with `docker run -i`).
# Set TRANSPORT=http to instead serve Streamable HTTP on $PORT at POST /mcp.
ENTRYPOINT ["node", "dist/index.js"]
