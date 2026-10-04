# Update Center hub
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-alpine
LABEL org.opencontainers.image.title="Update Center hub" \
      org.opencontainers.image.description="Self-hosted Linux fleet manager: web terminal, updates, reboots, Discord bot" \
      org.opencontainers.image.source="https://github.com/thekingziga/update-center" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0 DB_PATH=/data/hub.db
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY public ./public
COPY agent ./agent
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:${PORT}/api/state >/dev/null || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
