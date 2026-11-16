# One image: the RushDB engine, the memory service, and the viewer.
#
# The engine binary is dynamically linked against its own rootfs and that image has no
# shell, so the base is the engine image itself rather than a Debian we assemble. Node
# comes from the matching Debian release (both 12.15 / glibc 2.36), which is why a
# straight COPY works without a package manager.
FROM node:22-bookworm-slim AS node

FROM rushdb/rushdb:3.0.10

COPY --from=node /usr/local/bin/node /usr/local/bin/node

WORKDIR /app
COPY package.json /app/package.json
COPY src /app/src
COPY ui /app/ui
COPY adapters /app/adapters
COPY docker /app/docker

ENV AGENT_MEMORY_DATA_DIR=/data \
    AGENT_MEMORY_HOST=0.0.0.0 \
    AGENT_MEMORY_PORT=3001 \
    AGENT_MEMORY_ENGINE_URL=http://127.0.0.1:3000 \
    AGENT_MEMORY_ENGINE_PORT=3000

VOLUME ["/data"]
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD ["/usr/local/bin/node", "-e", "fetch('http://127.0.0.1:3001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# Same unprivileged user the engine image ships with.
USER 65532

ENTRYPOINT ["/usr/local/bin/node", "/app/docker/entrypoint.mjs"]
