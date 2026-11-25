FROM docker.io/oven/bun:1.4.5@sha256:3aa040e5445efa09d75bb428a64ba50db13e2b3ac9b6b0c7f145615f62b2ee18 AS build

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
FROM docker.io/oven/bun:1.4.5-distroless@sha256:3a210956422ad81cf7532e1fc1f2eb9275d6ef4c2337a9d25d530f798e80726a

WORKDIR /app

COPY --from=build /app /app

# Expose the bot HTTP port
EXPOSE 3000

ARG VCS_REF=unknown
LABEL org.opencontainers.image.revision="${VCS_REF}"

# The entrypoint is bun: start the bot
CMD ["src/bot.ts"]
