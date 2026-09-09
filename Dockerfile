ARG BROWSER_IMAGE=microsoft-rewards-next-browser:patchright-1.61.1

FROM ${BROWSER_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig*.json vite.config.ts vitest.config.ts eslint.config.js ./
COPY src ./src
RUN npm run build \
    && npm prune --omit=dev

FROM ${BROWSER_IMAGE} AS runtime
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    DATA_DIR=/app/data \
    SESSIONS_DIR=/app/sessions \
    WEB_HOST=0.0.0.0 \
    WEB_PORT=3000
WORKDIR /app
RUN mkdir -p /app/data /app/sessions /app/logs /app/backups \
    && chown -R node:node /app
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/package-lock.json ./package-lock.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=60s --timeout=10s --retries=3 --start-period=30s \
  CMD node -e "require('http').get('http://127.0.0.1:3000/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "dist/server/index.js"]
