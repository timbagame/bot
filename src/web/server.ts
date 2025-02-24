import type { Serve } from 'bun';
import { join } from 'path';
import { readFileSync } from 'fs';
import crypto from 'crypto';
import { config } from '../config';
import { connectToDatabase } from '../db/connection';
import { UserModel } from '../db/models/user';
import { WalletService } from '../services/wallet';

// Initialize services
const userModel = new UserModel();
const walletService = new WalletService();

// Verify Telegram WebApp data
function verifyTelegramWebAppData(telegramData: string): { isValid: boolean; telegramUser?: any; telegramId?: number } {
  try {
    if (!telegramData) {
      return { isValid: false };
    }

    // Parse the initData
    const urlParams = new URLSearchParams(telegramData);
    const dataCheckString = Array.from(urlParams.entries())
      .filter(([key]) => key !== 'hash')
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');

    const hash = urlParams.get('hash');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(config.telegram.botToken).digest();
    const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    if (hash !== calculatedHash) {
      return { isValid: false };
    }

    // Extract user information
    const user = JSON.parse(urlParams.get('user') || '{}');
    return {
      isValid: true,
      telegramUser: user,
      telegramId: user.id
    };
  } catch (error) {
    console.error('Error verifying Telegram data:', error);
    return { isValid: false };
  }
}

// Create the server
export const server = Bun.serve({
  port: config.server.port,
  hostname: config.server.host,

  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // Serve static files for the Mini App
    if (path.startsWith('/mini-app')) {
      const filePath = path === '/mini-app' || path === '/mini-app/'
        ? join(import.meta.dir, 'mini-app', 'index.html')
        : join(import.meta.dir, path.substring(1));

      try {
        const file = Bun.file(filePath);
        if (await file.exists()) {
          return new Response(file);
        }
      } catch (error) {
        console.error('Error serving static file:', error);
      }

      return new Response('Not Found', { status: 404 });
    }

    // API routes
    if (path.startsWith('/api')) {
      // Get Telegram data from headers
      const telegramData = req.headers.get('telegram-data');

      // Verify Telegram data
      if (!telegramData) {
        return new Response(
          JSON.stringify({ success: false, error: 'Unauthorized: Missing Telegram data' }),
          { status: 401, headers: { 'Content-Type': 'application/json' } }
        );
      }

      const verification = verifyTelegramWebAppData(telegramData);

      if (!verification.isValid) {
        return new Response(
          JSON.stringify({ success: false, error: 'Unauthorized: Invalid Telegram data' }),
          { status: 401, headers: { 'Content-Type': 'application/json' } }
        );
      }

      const { telegramId, telegramUser } = verification;

      // Handle API routes
      if (path === '/api/wallet' && req.method === 'GET') {
        try {
          // Get the user's wallet
          const publicKey = await walletService.getWallet(telegramId!);

          if (!publicKey) {
            return new Response(
              JSON.stringify({ success: true, wallet: null }),
              { headers: { 'Content-Type': 'application/json' } }
            );
          }

          // Get the wallet balance
          const balance = await walletService.getBalance(publicKey);

          return new Response(
            JSON.stringify({
              success: true,
              wallet: {
                publicKey,
                balance
              }
            }),
            { headers: { 'Content-Type': 'application/json' } }
          );
        } catch (error) {
          console.error('Error getting wallet:', error);
          return new Response(
            JSON.stringify({ success: false, error: 'Failed to get wallet information' }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
          );
        }
      }

      if (path === '/api/wallet/create' && req.method === 'POST') {
        try {
          const body = await req.json();
          const { password } = body;

          if (!password) {
            return new Response(
              JSON.stringify({ success: false, error: 'Password is required' }),
              { status: 400, headers: { 'Content-Type': 'application/json' } }
            );
          }

          // Check if the user already has a wallet
          const existingWallet = await walletService.getWallet(telegramId!);

          if (existingWallet) {
            return new Response(
              JSON.stringify({ success: false, error: 'You already have a wallet' }),
              { status: 400, headers: { 'Content-Type': 'application/json' } }
            );
          }

          // Create a user if they don't exist
          const existingUser = await userModel.findByTelegramId(telegramId!);

          if (!existingUser) {
            await userModel.create({
              telegramId: telegramId!,
              username: telegramUser.username,
              firstName: telegramUser.first_name,
              lastName: telegramUser.last_name
            });
          }

          // Generate a new wallet
          const publicKey = await walletService.generateWallet(telegramId!, password);

          return new Response(
            JSON.stringify({
              success: true,
              publicKey
            }),
            { headers: { 'Content-Type': 'application/json' } }
          );
        } catch (error) {
          console.error('Error creating wallet:', error);
          return new Response(
            JSON.stringify({ success: false, error: 'Failed to create wallet' }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
          );
        }
      }

      if (path === '/api/wallet/airdrop' && req.method === 'POST') {
        try {
          const body = await req.json();
          const amount = body.amount || 1;

          // Get the user's wallet
          const publicKey = await walletService.getWallet(telegramId!);

          if (!publicKey) {
            return new Response(
              JSON.stringify({ success: false, error: 'You don\'t have a wallet' }),
              { status: 400, headers: { 'Content-Type': 'application/json' } }
            );
          }

          // Request an airdrop
          await walletService.requestAirdrop(publicKey, amount);

          // Get the updated balance
          const balance = await walletService.getBalance(publicKey);

          return new Response(
            JSON.stringify({
              success: true,
              balance
            }),
            { headers: { 'Content-Type': 'application/json' } }
          );
        } catch (error) {
          console.error('Error requesting airdrop:', error);
          return new Response(
            JSON.stringify({ success: false, error: 'Failed to request airdrop' }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
          );
        }
      }

      // API route not found
      return new Response(
        JSON.stringify({ success: false, error: 'API endpoint not found' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Default response for unknown routes
    return new Response('Not Found', { status: 404 });
  },
});

// Start the server
export async function startWebServer(): Promise<void> {
  try {
    // Connect to the database
    await connectToDatabase();

    console.log(`Web server running at http://${config.server.host}:${config.server.port}`);
    console.log(`Mini App available at http://${config.server.host}:${config.server.port}/mini-app`);
  } catch (error) {
    console.error('Failed to start web server:', error);
    process.exit(1);
  }
}
