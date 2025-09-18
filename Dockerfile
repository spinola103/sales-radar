# Minimal Dockerfile for Puppeteer scraper (Node 18 + Google Chrome)
FROM node:18-slim

# Install Chrome dependencies and Google Chrome (stable)
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget \
    gnupg \
    ca-certificates \
    procps \
    libxss1 \
    libasound2 \
    fonts-liberation \
  && rm -rf /var/lib/apt/lists/*

# Add Google signing key & repo, install Chrome stable
RUN wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | apt-key add - \
  && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google.list' \
  && apt-get update \
  && apt-get install -y --no-install-recommends google-chrome-stable \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# --- Important: set Puppeteer env BEFORE npm install so it won't attempt to download Chromium ---
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
ENV NODE_ENV=production
ENV PORT=3000

# Copy package files first to leverage Docker cache
COPY package*.json ./

# Reduce npm fetch failures by config and install production deps
# - increase fetch retries/timeouts
RUN npm config set fetch-retries 5 \
 && npm config set fetch-retry-factor 2 \
 && npm config set fetch-retry-mintimeout 20000 \
 && npm config set fetch-retry-maxtimeout 120000 \
 && npm ci --only=production --no-audit --progress=false

# Copy application source
COPY . .

# Ensure results dir exists (your code writes output.json)
RUN mkdir -p /app/results

EXPOSE 3000

CMD ["npm", "start"]
