FROM docker.io/oven/bun:latest

WORKDIR /app

# Copy dependency manifests first for better caching
COPY package.json bun.lock bunfig.toml .npmrc ./

# Install dependencies using the exact lockfile
RUN --mount=type=secret,id=npm_token \
    NODE_AUTH_TOKEN="$(cat /run/secrets/npm_token)" bun install --frozen-lockfile

# Copy the rest of the application source
COPY tsconfig.json ./tsconfig.json
COPY src ./src
COPY scripts ./scripts
COPY idl ./idl

# Expose the bot HTTP port
EXPOSE 3000

# Start the bot
CMD ["bun", "start"]
