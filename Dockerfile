FROM node:24-bookworm-slim

WORKDIR /app

# 安装 Chromium 运行时必需的系统依赖库与中文字体支持
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-noto-cjk \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
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
    tzdata \
    && rm -rf /var/lib/apt/lists/*

ENV TZ=Asia/Shanghai
ENV PORT=5308
ENV DATA_DIR=/app/data

COPY package*.json ./
RUN npm install --omit=dev

# 安装内置 Patchright Chromium
RUN npx patchright-core install chromium || true

COPY . .

# 暴露 Web 控制台端口
EXPOSE 5308

VOLUME ["/app/data"]

CMD ["node", "src/index.js"]
