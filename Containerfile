FROM docker.io/oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS build

WORKDIR /app

# Copy dependency manifests first for better caching
COPY package.json bun.lock bunfig.toml .npmrc ./

# Install the runtime dependencies from the exact lockfile
RUN --mount=type=secret,id=npm_token \
    NODE_AUTH_TOKEN="$(cat /run/secrets/npm_token)" bun install --frozen-lockfile --production

# Optional candidate package for cross-repository protocol PR validation.
# The default production build uses only the frozen registry dependency.
RUN --mount=type=secret,id=protocol_package --mount=type=secret,id=npm_token \
    if [ -s /run/secrets/protocol_package ]; then \
      cp /run/secrets/protocol_package /tmp/protocol.tgz && \
      NODE_AUTH_TOKEN="$(cat /run/secrets/npm_token)" bun add --production /tmp/protocol.tgz && rm /tmp/protocol.tgz; \
    fi

# Copy the rest of the application source
COPY tsconfig.json ./tsconfig.json
COPY src ./src
COPY scripts ./scripts

# Distroless: Bun and glibc only. No shell or package manager, so an exploit gets no tools,
# health checks must use the exec form, and package scripts (`bun run <name>`) can't run:
# run files instead, such as `bun scripts/service-admin.ts`.
FROM docker.io/oven/bun:1.4.4-distroless@sha256:153a951ae40106e125898103e6e990ee0f38e6aee7f561029e26cf9fbed23470

WORKDIR /app

COPY --from=build /app /app

# Expose the bot HTTP port
EXPOSE 3000

ARG VCS_REF=unknown
LABEL org.opencontainers.image.revision="${VCS_REF}"

# The entrypoint is bun: start the bot
CMD ["src/bot.ts"]
