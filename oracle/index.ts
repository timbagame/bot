import { OracleService } from "./oracle-service.ts";

/**
 * Oracle API Server
 * Provides endpoints for requesting random hashes and tracks game completion
 */

const PORT = process.env.ORACLE_PORT || 3001;
const oracle = OracleService.getInstance();

// Initialize the server
const server = Bun.serve({
  port: PORT,
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    // Handle CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 200,
        headers: corsHeaders
      });
    }

    try {
      // Health check endpoint
      if (path === '/health' && method === 'GET') {
        return new Response(JSON.stringify({
          status: 'healthy',
          timestamp: new Date().toISOString(),
          uptime: process.uptime()
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      }

      // Generate random hash endpoint
      if (path === '/generate-hash' && method === 'POST') {
        try {
          const secrets = oracle.generateGameSecrets();

          return new Response(JSON.stringify({
            success: true,
            randomHash: secrets.randomHash,
            gameAddress: secrets.gameAddress
          }), {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              ...corsHeaders
            }
          });
        } catch (error: any) {
          console.error('Error generating hash:', error);
          return new Response(JSON.stringify({
            success: false,
            error: error.message
          }), {
            status: 500,
            headers: {
              'Content-Type': 'application/json',
              ...corsHeaders
            }
          });
        }
      }

      // Track game endpoint
      if (path === '/track-game' && method === 'POST') {
        try {
          const body = await request.json();
          const { gameAddress } = body;

          if (!gameAddress) {
            return new Response(JSON.stringify({
              success: false,
              error: 'gameAddress is required'
            }), {
              status: 400,
              headers: {
                'Content-Type': 'application/json',
                ...corsHeaders
              }
            });
          }

          oracle.trackGame(gameAddress);

          return new Response(JSON.stringify({
            success: true,
            message: `Game ${gameAddress} is now being tracked`
          }), {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              ...corsHeaders
            }
          });
        } catch (error: any) {
          console.error('Error tracking game:', error);
          return new Response(JSON.stringify({
            success: false,
            error: error.message
          }), {
            status: 500,
            headers: {
              'Content-Type': 'application/json',
              ...corsHeaders
            }
          });
        }
      }

      // Manual game completion endpoint (for testing/debugging)
      if (path === '/complete-game' && method === 'POST') {
        try {
          const body = await request.json();
          const { gameAddress } = body;

          if (!gameAddress) {
            return new Response(JSON.stringify({
              success: false,
              error: 'gameAddress is required'
            }), {
              status: 400,
              headers: {
                'Content-Type': 'application/json',
                ...corsHeaders
              }
            });
          }

          const result = await oracle.completeGame(gameAddress);

          return new Response(JSON.stringify(result), {
            status: result.success ? 200 : 400,
            headers: {
              'Content-Type': 'application/json',
              ...corsHeaders
            }
          });
        } catch (error: any) {
          console.error('Error completing game:', error);
          return new Response(JSON.stringify({
            success: false,
            error: error.message
          }), {
            status: 500,
            headers: {
              'Content-Type': 'application/json',
              ...corsHeaders
            }
          });
        }
      }

      // Get Oracle statistics
      if (path === '/stats' && method === 'GET') {
        try {
          const stats = oracle.getStats();

          return new Response(JSON.stringify({
            success: true,
            stats,
            timestamp: new Date().toISOString()
          }), {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              ...corsHeaders
            }
          });
        } catch (error: any) {
          console.error('Error getting stats:', error);
          return new Response(JSON.stringify({
            success: false,
            error: error.message
          }), {
            status: 500,
            headers: {
              'Content-Type': 'application/json',
              ...corsHeaders
            }
          });
        }
      }

      // API documentation endpoint
      if (path === '/' && method === 'GET') {
        const documentation = `
          <html>
            <head><title>Oracle API</title></head>
            <body>
              <h1>Oracle API Documentation</h1>
              <h2>Endpoints:</h2>
              <ul>
                <li><code>GET /health</code> - Health check</li>
                <li><code>POST /generate-hash</code> - Generate random hash for new game</li>
                <li><code>POST /track-game</code> - Start tracking a game for completion</li>
                <li><code>POST /complete-game</code> - Manually complete a game (for testing)</li>
                <li><code>GET /stats</code> - Get Oracle statistics</li>
              </ul>
              <h2>Usage Examples:</h2>
              <pre>
# Generate hash for new game
curl -X POST http://localhost:${PORT}/generate-hash

# Track a game
curl -X POST http://localhost:${PORT}/track-game \\
  -H "Content-Type: application/json" \\
  -d '{"gameAddress": "GAME_ADDRESS_HERE"}'

# Get statistics
curl http://localhost:${PORT}/stats
              </pre>
            </body>
          </html>
        `;

        return new Response(documentation, {
          status: 200,
          headers: {
            'Content-Type': 'text/html',
            ...corsHeaders
          }
        });
      }

      // 404 for unknown endpoints
      return new Response(JSON.stringify({
        success: false,
        error: 'Endpoint not found'
      }), {
        status: 404,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });

    } catch (error: any) {
      console.error('Server error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Internal server error'
      }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    }
  },
});

// Start background game completion process
console.log('🔮 Starting Oracle API Server...');
console.log(`📡 Server running on http://localhost:${PORT}`);
console.log('🔍 Background game completion process starting...');

// Process pending games every 30 seconds
setInterval(async () => {
  try {
    await oracle.processPendingGames();
  } catch (error) {
    console.error('Error in background game processing:', error);
  }
}, 30000);

// Log stats every 5 minutes
setInterval(() => {
  const stats = oracle.getStats();
  console.log('📊 Oracle Stats:', {
    ...stats,
    timestamp: new Date().toISOString()
  });
}, 5 * 60 * 1000);

// Graceful shutdown
const shutdown = async (signal: string) => {
  console.log(`\n🛑 Received ${signal}, shutting down Oracle API...`);
  server.stop();
  console.log('✅ Oracle API stopped successfully');
  process.exit(0);
};

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

console.log('✅ Oracle API is running!');
console.log('📋 Available endpoints:');
console.log(`   GET  http://localhost:${PORT}/health`);
console.log(`   POST http://localhost:${PORT}/generate-hash`);
console.log(`   POST http://localhost:${PORT}/track-game`);
console.log(`   POST http://localhost:${PORT}/complete-game`);
console.log(`   GET  http://localhost:${PORT}/stats`);
console.log(`   GET  http://localhost:${PORT}/ (documentation)`);
