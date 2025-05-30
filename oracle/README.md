# Oracle API 🔮

A production-ready Oracle service for Solana Coinflip games with comprehensive monitoring, error handling, and security features.

## 🚀 Key Features

### 🔐 Security & Authentication

- **API Key Authentication**: Optional API key protection for sensitive endpoints
- **Rate Limiting**: 100 requests per minute per IP (configurable)
- **CORS Support**: Proper cross-origin request handling

### 📊 Enhanced Monitoring

- **Comprehensive Metrics**: Detailed performance and success tracking
- **Failed Game Debugging**: View and analyze failed completions
- **Pending Game Monitoring**: Track games waiting for completion
- **Real-time Health Checks**: Detailed system status with Oracle metrics

### 🔄 Improved Reliability

- **Smart Retry Logic**: Automatic retry with exponential backoff for transient errors
- **Better Error Classification**: Distinguishes between retryable and permanent errors
- **Adaptive Scanning**: Automatically adjusts scan frequency based on workload
- **Database Optimization**: Indexed queries and automatic cleanup

### 🛠 Performance Optimizations

- **Efficient Account Filtering**: Reduced RPC calls with better discriminator filtering
- **Prioritized Processing**: Database-tracked pending games processed first
- **Connection Pooling**: Improved Solana RPC connection handling
- **Memory Management**: Automatic cleanup of old records

## 📡 API Endpoints

### Public Endpoints

- `GET /health` - System health with detailed metrics
- `GET /stats?hours=24` - Comprehensive Oracle statistics
- `GET /pending-games` - Monitor games waiting for completion
- `GET /failed-games?limit=50` - Debug failed game completions
- `GET /` - Interactive API documentation

### Protected Endpoints (require API key)

- `POST /generate-hash` - Generate secrets for new games
- `POST /complete-game` - Manually complete a specific game
- `POST /force-scan` - Trigger immediate blockchain scan

## 🔧 Configuration

### Environment Variables

```bash
# Required
SOLANA_NETWORK=https://api.devnet.solana.com

# Optional Security
ORACLE_API_KEY=your_secret_api_key_here

# Optional Performance Tuning
ORACLE_PORT=3001
RATE_LIMIT_MAX_REQUESTS=100
RATE_LIMIT_WINDOW=60000
```

### Authentication

When `ORACLE_API_KEY` is set, protected endpoints require authentication:

```bash
# Header method
curl -H "Authorization: Bearer YOUR_API_KEY" \
  -X POST http://localhost:3001/generate-hash

# Query parameter method
curl -X POST "http://localhost:3001/generate-hash?api_key=YOUR_API_KEY"
```

## 🚀 Quick Start

1. **Install dependencies**

   ```bash
   bun install
   ```

2. **Configure environment**

   ```bash
   cp env.example .env
   # Edit .env with your settings
   ```

3. **Start the Oracle**
   ```bash
   bun start
   ```

## 📊 Monitoring & Observability

### Health Check

```bash
curl http://localhost:3001/health
```

Returns detailed system information including:

- Server uptime and version
- Request statistics and error rates
- Oracle performance metrics
- Current game counts

### Statistics Dashboard

```bash
curl "http://localhost:3001/stats?hours=24"
```

Provides comprehensive metrics:

- Secret generation and usage
- Game completion rates
- Error tracking
- Performance statistics
- 24-hour activity summary

### Real-time Monitoring

```bash
# Monitor pending games
curl http://localhost:3001/pending-games

# Check failed completions
curl http://localhost:3001/failed-games

# Force immediate scan
curl -X POST http://localhost:3001/force-scan \
  -H "Authorization: Bearer YOUR_API_KEY"
```

## 🔍 How It Works

### Automatic Game Completion

1. **Game Creation**: Call `/generate-hash` to get secrets for new games
2. **Background Scanning**: Oracle automatically scans every 30 seconds
3. **Smart Processing**: Prioritizes database-tracked games over blockchain discovery
4. **Adaptive Timing**: Adjusts scan frequency based on workload
5. **Reliable Completion**: Retry mechanism handles transient failures

### Database Schema

The Oracle maintains detailed tracking with:

- **secret_keys**: Game secrets and usage tracking
- **game_tracking**: Game lifecycle and completion attempts
- **metrics**: Performance and error metrics

### Error Handling

- **Retryable Errors**: Network issues, timeouts, RPC errors
- **Permanent Errors**: Invalid games, missing secrets, authorization failures
- **Smart Retry System**: Progressive cooldowns instead of hard retry limits
  - **Immediate Retries**: 2 quick retries for transient errors (timeouts, network issues)
  - **Progressive Cooldowns**: 5min → 30min → 2hr → 6hr based on attempt count
  - **Auto-Reset**: Retry counters reset after 24 hours (game conditions may have changed)
  - **Never Permanently Skipped**: Games are never permanently abandoned

## 🛡 Security Features

### Rate Limiting

- Default: 100 requests per minute per IP
- Headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`
- Configurable limits and windows

### API Key Authentication

- Optional but recommended for production
- Supports header and query parameter methods
- Public endpoints remain accessible

### Input Validation

- Solana public key validation
- Request body validation
- Error message sanitization

## 🔧 Advanced Configuration

### Adaptive Scanning

The Oracle automatically adjusts scan frequency:

- **Normal**: 30 seconds when games need processing
- **Reduced**: Up to 2 minutes when no work available
- **Burst**: Immediate processing for pending games

### Database Maintenance

- **Automatic Cleanup**: Removes records older than 30 days
- **Index Optimization**: Efficient queries for large datasets
- **Metrics Retention**: Configurable data retention periods

### Performance Tuning

```typescript
// Configurable timeouts
TRANSACTION_TIMEOUT = 60000;
CONNECTION_TIMEOUT = 30000;
RETRY_DELAY = 5000;
MAX_RETRIES = 3;
```

## 📈 Production Deployment

### Recommended Setup

```bash
# Production environment
SOLANA_NETWORK=https://api.mainnet-beta.solana.com
ORACLE_API_KEY=your_strong_random_key
ORACLE_PORT=3001

# Enhanced security
RATE_LIMIT_MAX_REQUESTS=50
RATE_LIMIT_WINDOW=60000

# Performance optimization
DATABASE_CLEANUP_DAYS=30
```

### Monitoring Integration

The Oracle provides metrics endpoints compatible with:

- Prometheus/Grafana monitoring
- Custom alerting systems
- Health check services
- Load balancer integration

### Error Alerting

Monitor these endpoints for alerts:

- `/health` - Overall system health
- `/stats` - Error rate thresholds
- `/failed-games` - Failed completion tracking

## 🧪 Testing

### Manual Testing

```bash
# Generate game secrets
curl -X POST http://localhost:3001/generate-hash

# Monitor the process
curl http://localhost:3001/pending-games

# Check completion
curl http://localhost:3001/stats
```

### Integration Testing

The Oracle provides endpoints for integration with your game client:

1. Call `/generate-hash` before game creation
2. Use returned `randomHash` and `gameAddress` in your transaction
3. Monitor completion via `/pending-games` or `/stats`

## 🤝 Contributing

The Oracle API is designed for extensibility:

- Modular error handling system
- Pluggable metrics collection
- Configurable retry strategies
- Extensible endpoint framework

## 🔗 Related

- [Game Client Integration Guide](../bot/README.md)
- [Solana Program Documentation](../README.md)
- [Development Setup](./DEVELOPMENT.md)
