FROM node:24-slim

WORKDIR /app

ENV NODE_ENV=production \
    WEB_HOST=0.0.0.0 \
    WEB_PORT=3000 \
    WEB_DATA_DIR=/app/data \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning

COPY package.json ./package.json
COPY src ./src
COPY public ./public
COPY scripts ./scripts

RUN mkdir -p /app/data && chown -R node:node /app/data

USER node
EXPOSE 3000
CMD ["node", "src/server.mjs"]
