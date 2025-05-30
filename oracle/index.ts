import { OracleService } from "./oracle-service.ts";
import { PublicKey } from "@solana/web3.js";

/**
 * Oracle API Server with enhanced features
 * Provides endpoints for requesting random hashes, monitoring, and managing games
 */

const PORT = process.env["ORACLE_PORT"] || 3001;
const API_KEY = process.env["ORACLE_API_KEY"] || "";
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 100; // Max requests per window

// Rate limiting storage
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();

// Request tracking
let totalRequests = 0;
let errorCount = 0;
const startTime = Date.now();

const oracle = OracleService.getInstance();

// Rate limiting middleware
function checkRateLimit(clientId: string): { allowed: boolean; remaining: number; resetTime: number } {
  const now = Date.now();
  const clientData = rateLimitMap.get(clientId) || { count: 0, resetTime: now + RATE_LIMIT_WINDOW };

  // Reset if window expired
  if (now > clientData.resetTime) {
    clientData.count = 0;
    clientData.resetTime = now + RATE_LIMIT_WINDOW;
  }

  const allowed = clientData.count < RATE_LIMIT_MAX_REQUESTS;
  if (allowed) {
    clientData.count++;
  }

  rateLimitMap.set(clientId, clientData);

  return {
    allowed,
    remaining: Math.max(0, RATE_LIMIT_MAX_REQUESTS - clientData.count),
    resetTime: clientData.resetTime
  };
}

// Authentication middleware
function checkAuth(request: Request): { authorized: boolean; message?: string } {
  // Skip auth for health check and docs
  const url = new URL(request.url);
  const publicEndpoints = ['/health', '/', '/stats'];

  if (publicEndpoints.includes(url.pathname)) {
    return { authorized: true };
  }

  if (!API_KEY) {
    return { authorized: true }; // No auth required if no API key set
  }

  const authHeader = request.headers.get('Authorization');
  const providedKey = authHeader?.replace('Bearer ', '') || url.searchParams.get('api_key');

  if (providedKey !== API_KEY) {
    return { authorized: false, message: 'Invalid or missing API key' };
  }

  return { authorized: true };
}

// Get client ID for rate limiting
function getClientId(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  const realIp = request.headers.get('x-real-ip');
  const ip = forwarded?.split(',')[0] || realIp || 'unknown';
  return ip;
}

// Enhanced response helper
function createResponse(data: any, status: number = 200, headers: Record<string, string> = {}): Response {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
    ...headers
  };

  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders
  });
}

// Initialize the server
const server = Bun.serve({
  port: PORT,
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const clientId = getClientId(request);

    totalRequests++;

    // CORS preflight
    if (method === 'OPTIONS') {
      return createResponse(null, 200);
    }

    try {
      // Rate limiting
      const rateLimit = checkRateLimit(clientId);
      if (!rateLimit.allowed) {
        return createResponse({
          success: false,
          error: 'Rate limit exceeded',
          retryAfter: Math.ceil((rateLimit.resetTime - Date.now()) / 1000)
        }, 429, {
          'X-RateLimit-Limit': RATE_LIMIT_MAX_REQUESTS.toString(),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': Math.ceil(rateLimit.resetTime / 1000).toString()
        });
      }

      // Authentication
      const auth = checkAuth(request);
      if (!auth.authorized) {
        return createResponse({
          success: false,
          error: auth.message || 'Unauthorized'
        }, 401);
      }

      // Add rate limit headers to successful responses
      const rateLimitHeaders = {
        'X-RateLimit-Limit': RATE_LIMIT_MAX_REQUESTS.toString(),
        'X-RateLimit-Remaining': rateLimit.remaining.toString(),
        'X-RateLimit-Reset': Math.ceil(rateLimit.resetTime / 1000).toString()
      };

      // Health check endpoint with detailed info
      if (path === '/health' && method === 'GET') {
        const uptime = Date.now() - startTime;
        const stats = oracle.getStats();

        return createResponse({
          status: 'healthy',
          timestamp: new Date().toISOString(),
          uptime: Math.floor(uptime / 1000),
          requests: {
            total: totalRequests,
            errors: errorCount,
            errorRate: totalRequests > 0 ? Math.round((errorCount / totalRequests) * 100) : 0
          },
          oracle: {
            pendingGames: stats.pendingGames,
            completedGames: stats.completedGames,
            failedGames: stats.failedGames,
            avgCompletionAttempts: stats.avgCompletionAttempts
          }
        }, 200, rateLimitHeaders);
      }

      // Generate random hash endpoint
      if (path === '/generate-hash' && method === 'POST') {
        try {
          const secrets = oracle.generateGameSecrets();

          return createResponse({
            success: true,
            randomHash: secrets.randomHash,
            gameAddress: secrets.gameAddress,
            timestamp: new Date().toISOString()
          }, 200, rateLimitHeaders);
        } catch (error: any) {
          console.error('Error generating hash:', error);
          errorCount++;
          return createResponse({
            success: false,
            error: error.message
          }, 500, rateLimitHeaders);
        }
      }

      // Manual game completion endpoint (for testing/debugging)
      if (path === '/complete-game' && method === 'POST') {
        try {
          const body = await request.json();
          const { gameAddress } = body;

          if (!gameAddress) {
            return createResponse({
              success: false,
              error: 'gameAddress is required'
            }, 400, rateLimitHeaders);
          }

          // Validate that gameAddress is a valid Solana public key
          try {
            new PublicKey(gameAddress);
          } catch (error) {
            return createResponse({
              success: false,
              error: 'Invalid gameAddress: must be a valid Solana public key'
            }, 400, rateLimitHeaders);
          }

          const result = await oracle.completeGame(gameAddress);

          return createResponse(result, result.success ? 200 : 400, rateLimitHeaders);
        } catch (error: any) {
          console.error('Error completing game:', error);
          errorCount++;
          return createResponse({
            success: false,
            error: error.message
          }, 500, rateLimitHeaders);
        }
      }

      // Enhanced statistics endpoint
      if (path === '/stats' && method === 'GET') {
        try {
          const stats = oracle.getStats();
          const hours = parseInt(url.searchParams.get('hours') || '24');

          return createResponse({
            success: true,
            stats: {
              ...stats,
              server: {
                uptime: Math.floor((Date.now() - startTime) / 1000),
                totalRequests,
                errorCount,
                errorRate: totalRequests > 0 ? Math.round((errorCount / totalRequests) * 100) : 0
              }
            },
            timestamp: new Date().toISOString(),
            hoursFilter: hours
          }, 200, rateLimitHeaders);
        } catch (error: any) {
          console.error('Error getting stats:', error);
          errorCount++;
          return createResponse({
            success: false,
            error: error.message
          }, 500, rateLimitHeaders);
        }
      }

      // Failed games endpoint for debugging
      if (path === '/failed-games' && method === 'GET') {
        try {
          const limit = parseInt(url.searchParams.get('limit') || '50');
          const db = oracle['db']; // Access private property for debugging
          const failedGames = db.getFailedGames(limit);

          return createResponse({
            success: true,
            failedGames,
            count: failedGames.length,
            timestamp: new Date().toISOString()
          }, 200, rateLimitHeaders);
        } catch (error: any) {
          console.error('Error getting failed games:', error);
          errorCount++;
          return createResponse({
            success: false,
            error: error.message
          }, 500, rateLimitHeaders);
        }
      }

      // Pending games endpoint for monitoring
      if (path === '/pending-games' && method === 'GET') {
        try {
          const db = oracle['db']; // Access private property for monitoring
          const pendingGames = db.getPendingGames();

          return createResponse({
            success: true,
            pendingGames: pendingGames.map(game => ({
              ...game,
              ageHours: Math.round((Date.now() - game.first_seen) / (1000 * 60 * 60) * 100) / 100
            })),
            count: pendingGames.length,
            timestamp: new Date().toISOString()
          }, 200, rateLimitHeaders);
        } catch (error: any) {
          console.error('Error getting pending games:', error);
          errorCount++;
          return createResponse({
            success: false,
            error: error.message
          }, 500, rateLimitHeaders);
        }
      }

      // Force scan endpoint (admin only)
      if (path === '/force-scan' && method === 'POST') {
        try {
          console.log('🔧 Manual scan triggered');
          const result = await oracle.scanAndCompleteActiveGames();

          return createResponse({
            success: true,
            scanResult: result,
            timestamp: new Date().toISOString()
          }, 200, rateLimitHeaders);
        } catch (error: any) {
          console.error('Error in manual scan:', error);
          errorCount++;
          return createResponse({
            success: false,
            error: error.message
          }, 500, rateLimitHeaders);
        }
      }

      // Enhanced API documentation endpoint
      if (path === '/' && method === 'GET') {
        const documentation = `
          <html>
            <head>
              <title>Oracle API</title>
              <style>
                body { font-family: Arial, sans-serif; margin: 40px; line-height: 1.6; }
                code { background: #f4f4f4; padding: 2px 4px; border-radius: 3px; }
                pre { background: #f4f4f4; padding: 15px; border-radius: 5px; overflow-x: auto; }
                .endpoint { background: #e8f5e8; padding: 10px; margin: 10px 0; border-radius: 5px; }
                .method { font-weight: bold; color: #2c5aa0; }
                .auth-required { color: #d9534f; font-size: 0.9em; }
              </style>
            </head>
            <body>
              <h1>🔮 Oracle API Documentation</h1>

              <h2>📊 System Status</h2>
              <p>The Oracle automatically scans the blockchain every 30 seconds for games that need completion.</p>
              <p>Current uptime: ${Math.floor((Date.now() - startTime) / 1000)}s | Total requests: ${totalRequests}</p>

              <h2>🔐 Authentication</h2>
              ${API_KEY ? `
                <p>API Key required for protected endpoints. Include in Authorization header:</p>
                <pre>Authorization: Bearer YOUR_API_KEY</pre>
                <p>Or as query parameter: <code>?api_key=YOUR_API_KEY</code></p>
              ` : '<p class="auth-required">⚠️ No API key configured - all endpoints are public</p>'}

              <h2>📡 Endpoints</h2>

              <div class="endpoint">
                <div class="method">GET</div> <code>/health</code>
                <p>Detailed health check with system metrics</p>
              </div>

              <div class="endpoint">
                <div class="method">POST</div> <code>/generate-hash</code> ${API_KEY ? '<span class="auth-required">🔒 Auth Required</span>' : ''}
                <p>Generate random hash for new game creation</p>
              </div>

              <div class="endpoint">
                <div class="method">POST</div> <code>/complete-game</code> ${API_KEY ? '<span class="auth-required">🔒 Auth Required</span>' : ''}
                <p>Manually complete a specific game (testing/debugging)</p>
                <pre>{"gameAddress": "GAME_ADDRESS_HERE"}</pre>
              </div>

              <div class="endpoint">
                <div class="method">GET</div> <code>/stats?hours=24</code>
                <p>Comprehensive Oracle statistics and metrics</p>
              </div>

              <div class="endpoint">
                <div class="method">GET</div> <code>/pending-games</code>
                <p>List of games waiting for completion</p>
              </div>

              <div class="endpoint">
                <div class="method">GET</div> <code>/failed-games?limit=50</code>
                <p>List of games that failed to complete</p>
              </div>

              <div class="endpoint">
                <div class="method">POST</div> <code>/force-scan</code> ${API_KEY ? '<span class="auth-required">🔒 Auth Required</span>' : ''}
                <p>Trigger immediate blockchain scan</p>
              </div>

              <h2>⚡ Rate Limiting</h2>
              <p>Limit: ${RATE_LIMIT_MAX_REQUESTS} requests per ${RATE_LIMIT_WINDOW / 1000} seconds per IP</p>
              <p>Rate limit headers included in responses:</p>
              <ul>
                <li><code>X-RateLimit-Limit</code>: Maximum requests allowed</li>
                <li><code>X-RateLimit-Remaining</code>: Requests remaining in current window</li>
                <li><code>X-RateLimit-Reset</code>: Unix timestamp when limit resets</li>
              </ul>

              <h2>🚀 Usage Examples</h2>
              <pre>
# Generate hash for new game
curl -X POST "http://localhost:${PORT}/generate-hash" \\
  ${API_KEY ? '-H "Authorization: Bearer YOUR_API_KEY"' : ''}

# Get comprehensive statistics
curl "http://localhost:${PORT}/stats?hours=24"

# Check system health
curl "http://localhost:${PORT}/health"

# Monitor pending games
curl "http://localhost:${PORT}/pending-games"

# Force immediate scan (admin)
curl -X POST "http://localhost:${PORT}/force-scan" \\
  ${API_KEY ? '-H "Authorization: Bearer YOUR_API_KEY"' : ''}
              </pre>

              <h2>📈 Monitoring</h2>
              <p>The Oracle provides extensive metrics for monitoring:</p>
              <ul>
                <li>Game completion success rates</li>
                <li>Average completion times</li>
                <li>Error tracking and categorization</li>
                <li>Performance metrics</li>
                <li>Request volume and rate limiting</li>
              </ul>
            </body>
          </html>
        `;

        return new Response(documentation, {
          status: 200,
          headers: {
            'Content-Type': 'text/html',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }

      // 404 for unknown endpoints
      return createResponse({
        success: false,
        error: 'Endpoint not found',
        availableEndpoints: [
          'GET /health',
          'POST /generate-hash',
          'POST /complete-game',
          'GET /stats',
          'GET /pending-games',
          'GET /failed-games',
          'POST /force-scan',
          'GET / (documentation)'
        ]
      }, 404, rateLimitHeaders);

    } catch (error: any) {
      console.error('Server error:', error);
      errorCount++;
      return createResponse({
        success: false,
        error: 'Internal server error'
      }, 500);
    }
  },
});

// Startup and background processes
console.log('🔮 Starting Oracle API Server...');
console.log(`📡 Server running on http://localhost:${PORT}`);
console.log(`🔐 Authentication: ${API_KEY ? 'Enabled' : 'Disabled'}`);
console.log(`⚡ Rate limiting: ${RATE_LIMIT_MAX_REQUESTS} requests per ${RATE_LIMIT_WINDOW / 1000}s`);
console.log('🔍 Background game completion process starting...');

// Main scanning interval with adaptive timing
let scanInterval = 30000; // Start with 30 seconds
let consecutiveEmptyScans = 0;

setInterval(async () => {
  try {
    const result = await oracle.scanAndCompleteActiveGames();

    // Adaptive scanning: slow down if no work to do
    if (result.readyGames === 0) {
      consecutiveEmptyScans++;
      // Gradually increase interval up to 2 minutes if no games to process
      if (consecutiveEmptyScans > 5) {
        scanInterval = Math.min(120000, scanInterval * 1.1);
      }
    } else {
      consecutiveEmptyScans = 0;
      scanInterval = 30000; // Reset to normal speed when there's work
    }

  } catch (error) {
    console.error('Error in background game processing:', error);
    errorCount++;
  }
}, scanInterval);

// Enhanced stats logging every 5 minutes
setInterval(() => {
  const stats = oracle.getStats();
  const uptime = Math.floor((Date.now() - startTime) / 1000);
  console.log('📊 Oracle Status:', {
    uptime: `${Math.floor(uptime / 60)}m ${uptime % 60}s`,
    requests: { total: totalRequests, errors: errorCount },
    games: {
      pending: stats.pendingGames,
      completed: stats.completedGames,
      failed: stats.failedGames,
      avgAttempts: stats.avgCompletionAttempts
    },
    recent24h: stats.recentMetrics,
    timestamp: new Date().toISOString()
  });
}, 5 * 60 * 1000);

// Database cleanup every 24 hours
setInterval(() => {
  try {
    const db = oracle['db'];
    db.cleanup(30); // Clean up records older than 30 days
  } catch (error) {
    console.error('Error during database cleanup:', error);
  }
}, 24 * 60 * 60 * 1000);

// Graceful shutdown with cleanup
const shutdown = async (signal: string) => {
  console.log(`\n🛑 Received ${signal}, shutting down Oracle API...`);

  try {
    // Log final stats
    const stats = oracle.getStats();
    console.log('📊 Final stats:', stats);

    server.stop();
    console.log('✅ Oracle API stopped successfully');
    process.exit(0);
  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
};

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

console.log('✅ Oracle API is running!');
console.log('📋 Available endpoints:');
console.log(`   GET  http://localhost:${PORT}/health - Health check with metrics`);
console.log(`   POST http://localhost:${PORT}/generate-hash - Generate game secrets ${API_KEY ? '🔒' : ''}`);
console.log(`   POST http://localhost:${PORT}/complete-game - Manual completion ${API_KEY ? '🔒' : ''}`);
console.log(`   GET  http://localhost:${PORT}/stats - Comprehensive statistics`);
console.log(`   GET  http://localhost:${PORT}/pending-games - Monitor pending games`);
console.log(`   GET  http://localhost:${PORT}/failed-games - Debug failed games`);
console.log(`   POST http://localhost:${PORT}/force-scan - Force blockchain scan ${API_KEY ? '🔒' : ''}`);
console.log(`   GET  http://localhost:${PORT}/ - Interactive documentation`);
console.log('');
console.log('🔧 Environment:');
console.log(`   ORACLE_PORT=${PORT}`);
console.log(`   ORACLE_API_KEY=${API_KEY ? 'SET' : 'NOT SET'}`);
console.log(`   SOLANA_NETWORK=${process.env["SOLANA_NETWORK"] || 'NOT SET'}`);
