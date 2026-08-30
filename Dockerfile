###############################################################################
# Stage 1: Builder
###############################################################################
FROM m.daocloud.io/docker.io/library/node:24-slim AS builder

WORKDIR /usr/src/microsoft-rewards-script

# Copy package files
COPY package.json package-lock.json tsconfig.json ./

# Install all dependencies required to build the script
RUN npm ci --ignore-scripts

# Copy source and build
COPY . .
RUN npm run build

###############################################################################
# Stage 2: Production dependencies
###############################################################################
FROM m.daocloud.io/docker.io/library/node:24-slim AS production-deps

WORKDIR /usr/src/microsoft-rewards-script

COPY package.json package-lock.json ./

# Keep runtime dependencies independent from application source.
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

###############################################################################
# Stage 3: Runtime
###############################################################################
FROM m.daocloud.io/docker.io/library/node:24-slim AS runtime

WORKDIR /usr/src/microsoft-rewards-script

# Set production environment variables
ENV NODE_ENV=production \
    TZ=UTC \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    FORCE_HEADLESS=1 \
    WEB_UI_HOST=0.0.0.0 \
    WEB_UI_PORT=3000

# Install minimal system libraries required for Chromium headless to run,
# plus jq (for config generation/patching) and gettext-base (for envsubst)
RUN apt-get update && apt-get install -y --no-install-recommends \
    cron \
    gettext-base \
    jq \
    tzdata \
    ca-certificates \
    libglib2.0-0 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libasound2 \
    libflac12 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libdrm2 \
    libgbm1 \
    libdav1d6 \
    libx11-6 \
    libx11-xcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    libdouble-conversion3 \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

# Copy compiled application and production dependencies separately so
# source-only changes can reuse the dependency layer.
COPY --from=builder /usr/src/microsoft-rewards-script/dist ./dist
COPY --from=production-deps /usr/src/microsoft-rewards-script/package*.json ./
COPY --from=production-deps /usr/src/microsoft-rewards-script/node_modules ./node_modules

# Copy config example into the image so entrypoint can use it as a fallback
# when the user hasn't mounted their own config.json
COPY src/config.example.json ./src/config.example.json
COPY src/config.example.json ./dist/config.example.json

# Create the config directory and symlink config.json and accounts.json into
# dist/ so the app finds them at its expected paths, while the entrypoint
# writes to dist/config/ which maps to the user-facing ./config/ volume mount
RUN mkdir -p ./dist/config \
    && ln -s /usr/src/microsoft-rewards-script/dist/config/config.json ./dist/config.json \
    && ln -s /usr/src/microsoft-rewards-script/dist/config/accounts.json ./dist/accounts.json

# Copy runtime scripts with proper permissions from the start
COPY --chmod=755 scripts/docker/run_daily.sh ./scripts/docker/run_daily.sh
COPY --chmod=644 scripts/docker/check-browser.js ./scripts/docker/check-browser.js
COPY --chmod=755 scripts/docker/log-forwarder.sh ./scripts/docker/log-forwarder.sh
COPY --chmod=755 scripts/docker/schedule.sh ./scripts/docker/schedule.sh
COPY --chmod=644 src/crontab.template /etc/cron.d/microsoft-rewards-cron.template
COPY --chmod=755 scripts/docker/entrypoint.sh /usr/local/bin/entrypoint.sh

EXPOSE 3000

# Entrypoint handles TZ, accounts/config generation, initial run toggle,
# cron templating & launch
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["npm", "run", "web"]
