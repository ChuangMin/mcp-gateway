# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN pnpm install --frozen-lockfile
COPY packages packages
RUN pnpm -r build \
 && pnpm --filter @mcp-gateway/server deploy --prod /out

FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=3000 \
    WEB_DIST_DIR=/app/web/dist
WORKDIR /app
COPY --from=build /out ./server
COPY --from=build /app/packages/web/dist ./web/dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health > /dev/null || exit 1
CMD ["node", "server/dist/main.js"]
