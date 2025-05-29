# Oracle API

Independent Oracle service for Solana game completion. This service generates random hashes for new games and automatically completes games when they're ready.

## Features

- **Random Hash Generation**: Provides secure random hashes for game initialization
- **Automatic Game Completion**: Monitors and completes games when they're full or expired
- **Secret Key Management**: Securely stores and manages secret keys for game completion
- **REST API**: Clean HTTP API for integration with any client
- **Background Processing**: Continuously monitors games for completion
- **Statistics**: Real-time statistics and monitoring

## Quick Start

1. **Install dependencies**:

   ```bash
   bun install
   ```

2. **Copy admin keypair**:

   ```bash
   cp ../admin-keypair.json ./admin-keypair.json
   ```

3. **Set up environment**:

   ```bash
   cp env.example .env
   # Edit .env with your configuration
   ```

4. **Start the Oracle API**:
   ```bash
   bun start
   ```

The Oracle API will be available at `http://localhost:3001`.

## API Endpoints

### `POST /generate-hash`

Generate a random hash and secret key for a new game.

**Response:**

```json
{
  "success": true,
  "randomHash": "abc123...",
  "gameAddress": "GAME_PDA_ADDRESS"
}
```

### `POST /track-game`

Start tracking a game for automatic completion.

**Request:**

```json
{
  "gameAddress": "GAME_PDA_ADDRESS"
}
```

**Response:**

```json
{
  "success": true,
  "message": "Game GAME_PDA_ADDRESS is now being tracked"
}
```

### `POST /complete-game`

Manually complete a game (for testing/debugging).

**Request:**

```json
{
  "gameAddress": "GAME_PDA_ADDRESS"
}
```

**Response:**

```json
{
  "success": true,
  "txHash": "TRANSACTION_HASH"
}
```

### `GET /stats`

Get Oracle statistics.

**Response:**

```json
{
  "success": true,
  "stats": {
    "totalSecrets": 10,
    "usedSecrets": 5,
    "pendingGames": 3,
    "completedGames": 2
  },
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

### `GET /health`

Health check endpoint.

**Response:**

```json
{
  "status": "healthy",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "uptime": 12345.67
}
```

## Environment Variables

- `SOLANA_NETWORK`: Solana RPC endpoint (default: devnet)
- `ORACLE_PORT`: API server port (default: 3001)

## File Requirements

- `admin-keypair.json`: Admin keypair file (same as the bot)
- `.env`: Environment variables (copy from `env.example`)

## How It Works

1. **Hash Generation**: When requested, generates a cryptographically secure random hash and corresponding secret key
2. **Secret Storage**: Stores the secret key in a local SQLite database linked to the game address
3. **Game Tracking**: Games can be registered for tracking via the API
4. **Background Monitoring**: Every 30 seconds, checks all pending games for completion readiness
5. **Automatic Completion**: When a game is full or expired with enough players, automatically completes it using the stored secret
6. **Cleanup**: Marks secrets as used and games as completed after successful completion

## Integration Example

```javascript
// Generate hash for new game
const response = await fetch("http://localhost:3001/generate-hash", {
  method: "POST",
});
const { randomHash, gameAddress } = await response.json();

// Use randomHash to initialize game on-chain
// ...

// Start tracking the game
await fetch("http://localhost:3001/track-game", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ gameAddress }),
});

// Oracle will automatically complete the game when ready
```

## Development

- `bun dev`: Start with file watching
- `bun start`: Start in production mode

## Database

The Oracle uses SQLite for local storage:

- `oracle.sqlite`: Stores secret keys and game tracking information
- Automatically created on first run
- Contains tables for secret keys and game tracking status

## Security

- Secret keys are generated using crypto-secure random bytes
- Admin keypair is required for game completion transactions
- Only the Oracle service has access to the secret keys
- Games can only be completed by the authorized Oracle

## Monitoring

The Oracle logs important events and provides statistics:

- Game secret generation
- Game tracking start/stop
- Completion attempts and results
- Background processing status
- Regular statistics output every 5 minutes
