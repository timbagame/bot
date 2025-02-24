import { Bot, InlineKeyboard, session, GrammyError, HttpError, Context } from 'grammy';
import type { SessionFlavor } from 'grammy';
import { Menu } from '@grammyjs/menu';
import { config, validateConfig } from './config';
import { connectToDatabase, closeDatabaseConnection } from './db/connection';
import { UserModel } from './db/models/user';
import { WalletService } from './services/wallet';
import { startWebServer } from './web/server';

// Define session structure
interface SessionData {
  step: string | null;
  data: Record<string, any>;
}

// Define context type with session
type BotContext = Context & SessionFlavor<SessionData>;

// Validate configuration
validateConfig();

// Initialize services
const userModel = new UserModel();
const walletService = new WalletService();

// Create bot instance
const bot = new Bot<BotContext>(config.telegram.botToken);

// Use session middleware
bot.use(session({
  initial: (): SessionData => ({
    step: null,
    data: {},
  }),
}));

// Create a menu for wallet management
const walletMenu = new Menu<BotContext>('wallet-menu')
  .text('💰 My Wallet', async (ctx) => {
    const telegramId = ctx.from?.id;

    if (!telegramId) {
      await ctx.reply('Error: Could not identify user.');
      return;
    }

    const publicKey = await walletService.getWallet(telegramId);

    if (!publicKey) {
      await ctx.reply(
        'You don\'t have a wallet yet. Use the Mini App to create one.',
        { reply_markup: createWalletKeyboard() }
      );
      return;
    }

    const balance = await walletService.getBalance(publicKey);

    await ctx.reply(
      `💼 *Your Solana Wallet*\n\n` +
      `*Public Key:* \`${publicKey}\`\n` +
      `*Balance:* ${balance} SOL\n\n` +
      `Use the Mini App for more features.`,
      {
        parse_mode: 'Markdown',
        reply_markup: createWalletKeyboard()
      }
    );
  })
  .text('🔄 Request Airdrop', async (ctx) => {
    const telegramId = ctx.from?.id;

    if (!telegramId) {
      await ctx.reply('Error: Could not identify user.');
      return;
    }

    const publicKey = await walletService.getWallet(telegramId);

    if (!publicKey) {
      await ctx.reply(
        'You don\'t have a wallet yet. Use the Mini App to create one.',
        { reply_markup: createWalletKeyboard() }
      );
      return;
    }

    try {
      await ctx.reply('Requesting 1 SOL airdrop...');

      const signature = await walletService.requestAirdrop(publicKey, 1);
      const balance = await walletService.getBalance(publicKey);

      await ctx.reply(
        `✅ Airdrop successful!\n\n` +
        `*New Balance:* ${balance} SOL\n` +
        `*Transaction:* \`${signature}\``,
        { parse_mode: 'Markdown' }
      );
    } catch (error) {
      console.error('Airdrop error:', error);
      await ctx.reply('❌ Failed to request airdrop. Please try again later.');
    }
  });

// Register the menu with the bot
bot.use(walletMenu);

// Helper function to create a keyboard with the Mini App button
function createWalletKeyboard() {
  const keyboard = new InlineKeyboard()
    .webApp('🔐 Manage Wallet', config.telegram.miniAppUrl)
    .row()
    .text('💰 My Wallet', 'wallet-menu:my-wallet')
    .text('🔄 Request Airdrop', 'wallet-menu:request-airdrop');

  return keyboard;
}

// Command handlers
bot.command('start', async (ctx) => {
  if (!ctx.from) {
    await ctx.reply('Error: Could not identify user.');
    return;
  }

  const telegramId = ctx.from.id;
  const username = ctx.from.username || '';
  const firstName = ctx.from.first_name || '';
  const lastName = ctx.from.last_name || '';

  // Create or update user in database
  const existingUser = await userModel.findByTelegramId(telegramId);

  if (!existingUser) {
    await userModel.create({
      telegramId,
      username,
      firstName,
      lastName
    });
  }

  await ctx.reply(
    `Welcome to the Solana Wallet Bot! 🚀\n\n` +
    `This bot allows you to create and manage a Solana wallet directly from Telegram.\n\n` +
    `Use the buttons below to get started:`,
    { reply_markup: createWalletKeyboard() }
  );
});

bot.command('wallet', async (ctx) => {
  if (!ctx.from) {
    await ctx.reply('Error: Could not identify user.');
    return;
  }

  const telegramId = ctx.from.id;
  const publicKey = await walletService.getWallet(telegramId);

  if (!publicKey) {
    await ctx.reply(
      'You don\'t have a wallet yet. Use the Mini App to create one.',
      { reply_markup: createWalletKeyboard() }
    );
    return;
  }

  const balance = await walletService.getBalance(publicKey);

  await ctx.reply(
    `💼 *Your Solana Wallet*\n\n` +
    `*Public Key:* \`${publicKey}\`\n` +
    `*Balance:* ${balance} SOL\n\n` +
    `Use the Mini App for more features.`,
    {
      parse_mode: 'Markdown',
      reply_markup: createWalletKeyboard()
    }
  );
});

bot.command('help', (ctx) => {
  ctx.reply(
    `*Solana Wallet Bot Help*\n\n` +
    `Available commands:\n` +
    `/start - Start the bot and see the main menu\n` +
    `/wallet - View your wallet information\n` +
    `/help - Show this help message\n\n` +
    `Use the Mini App button to create and manage your wallet.`,
    { parse_mode: 'Markdown' }
  );
});

// Error handling
bot.catch((err) => {
  const ctx = err.ctx;
  console.error(`Error while handling update ${ctx.update.update_id}:`);
  const e = err.error;
  if (e instanceof GrammyError) {
    console.error('Error in request:', e.description);
  } else if (e instanceof HttpError) {
    console.error('Could not contact Telegram:', e);
  } else {
    console.error('Unknown error:', e);
  }
});

// Start the bot and web server
async function start() {
  try {
    // Connect to the database
    await connectToDatabase();

    // Start the web server for the Mini App
    await startWebServer();

    // Start the bot
    await bot.start();
    console.log('Bot started successfully!');

    // Handle shutdown
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (error) {
    console.error('Failed to start:', error);
    process.exit(1);
  }
}

// Graceful shutdown
async function shutdown() {
  console.log('Shutting down...');
  await bot.stop();
  await closeDatabaseConnection();
  process.exit(0);
}

// Start the application
start();
