# Mustermind — the wearability agent.
#
# Zero npm dependencies (see package.json) so there is nothing to install and
# no lockfile to reason about. Alpine keeps the resulting image under ~55 MB.
#
# Runs as a non-root user. Reads $PORT at runtime — Render, Fly, Cloud Run
# and most PaaS inject it. Defaults to 5173 for a bare `docker run`.

FROM node:20-alpine

# Non-root by default: the process only needs to bind a port and read files
# it packaged with. No shell escape shortcuts.
RUN addgroup -S app && adduser -S app -G app

WORKDIR /app

# Copy only what runs. `.dockerignore` keeps out .git, .claude/, work/, etc.
COPY --chown=app:app package.json ./
COPY --chown=app:app server.js ./
COPY --chown=app:app lib ./lib
COPY --chown=app:app public ./public
COPY --chown=app:app scripts ./scripts

USER app

# Documentation-only; the PaaS decides the actual public port via $PORT.
EXPOSE 5173

# Live AJIO search seeds the candidate list on boot; if the network is
# unreachable the demo falls back to fixture codes and labels itself as
# "Demo data". POW_ALLOW_ANY_STYLE is deliberately NOT set — the tighter
# invariant is that only codes AJIO's own search returned (added to the
# session allowlist) are fetchable. See lib/upstream.js.
ENV NODE_ENV=production

# Local docker health check. Render/Fly use their own probe (healthCheckPath
# in render.yaml). Alpine ships wget via busybox, so no extra install.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-5173}/api/brief" > /dev/null 2>&1 || exit 1

CMD ["node", "server.js"]
