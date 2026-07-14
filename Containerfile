FROM docker.io/oven/bun:latest

WORKDIR /app

# Copy dependency manifests first for better caching
COPY package.json bun.lock bunfig.toml ./

# Install dependencies using the exact lockfile
RUN bun install --frozen-lockfile

# Copy the rest of the application source
COPY tsconfig.json ./tsconfig.json
COPY game-tokens-info.json ./game-tokens-info.json
COPY src ./src
COPY scripts ./scripts
COPY idl ./idl

# Expose the bot HTTP port
EXPOSE 3000

# Start the bot
CMD ["bun", "start"]
