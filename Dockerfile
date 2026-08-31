# Footlore has no dependencies, so there is nothing to install and no build step —
# this image is the Node runtime plus four directories of source.
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8080 \
    FOOTLORE_CACHE=/data/cache

WORKDIR /app
COPY package.json ./
COPY server ./server
COPY solver ./solver
COPY web ./web

# The disk cache lives on a mounted volume. Overpass and Wikipedia are slow and
# rate-limited; losing this on every deploy would mean a cold, rude first hour.
# Runs as root because the mounted volume arrives root-owned.
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

CMD ["node", "server/index.mjs"]
