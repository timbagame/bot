FROM oven/bun:latest

WORKDIR /app

# Install dependencies using lockfile for reproducible builds
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile

# Copy application source
COPY tsconfig.json ./tsconfig.json
COPY game-tokens-info.json ./game-tokens-info.json
COPY src ./src
COPY scripts ./scripts
COPY idl ./idl

CMD ["bun", "start"]
