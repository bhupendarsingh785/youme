FROM node:22-alpine

WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public
COPY scripts ./scripts

# Database yahan rehta hai — isko volume se jodo, warna container restart par data chala jayega
RUN mkdir -p /data && chown node:node /data
VOLUME /data

ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/youme.db

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
