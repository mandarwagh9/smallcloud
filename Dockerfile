# smallcloud: one process, one volume.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY bin ./bin
COPY examples ./examples

# App processes run as a separate OS user, so the kernel enforces isolation even where
# Node's permission model does not (see SECURITY.md, "The node:sqlite gap").
RUN groupadd --system --gid 10001 scapp && useradd --system --no-create-home --uid 10001 --gid 10001 scapp
ENV SC_DATA_DIR=/data SC_APP_UID=10001 SC_APP_GID=10001

# The control plane runs as root so it can drop to scapp when forking app hosts, and so
# platform.db stays unreadable to that user. Entry point tightens the modes on boot.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
VOLUME /data
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/cli.js", "serve"]
