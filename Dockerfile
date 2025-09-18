# Minimal Dockerfile for the Puppeteer scraper (Node 18 + Google Chrome)
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

RUN wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | apt-key add - \
  && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google.list' \
  && apt-get update \
  && apt-get install -y --no-install-recommends google-chrome-stable \
  && rm -rf /var/lib/apt/lists/*

# App dir
WORKDIR /app

# Copy package files & install production deps
COPY package*.json ./
RUN npm ci --only=production

# Copy application source
COPY . .

# Ensure results dir exists (your code writes output.json)
RUN mkdir -p /app/results

# Puppeteer config: don't download Chromium, use system Chrome
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Start app
CMD ["npm", "start"]
