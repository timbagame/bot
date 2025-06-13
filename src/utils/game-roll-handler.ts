import { PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import type { GameData } from "../types";
import { handleCallbackErrorSafe } from "./context-helpers";

// ================================
// GAME ROLL HANDLING
// ================================

/**
 * Main entry point for handling game rolls - replaces the complex handleGameRoll function
 */
export const handleGameRoll = async (
  ctx: any,
  gamePda: PublicKey,
  playerKp: anchor.web3.Keypair,
  gameAccount: any,
  gameData: GameData,
  game: GameData
): Promise<void> => {
  try {
    const { wallet } = await import("../bot");
    
    let rollInstruction: any;
    let signers: anchor.web3.Keypair[];
    
    if (gameAccount.isPrivate) {
      const { OracleClient } = await import("./oracle");
      const oracleClient = OracleClient.getInstance(wallet);
      const authResult = await oracleClient.authorizePlayer(gamePda, ctx.chat?.id || 0);
      
      if (!authResult.authorized) {
        const errorMessage = authResult.error || "Not authorized to roll this game";
        await safeAnswerCallbackQuery(ctx, errorMessage);
        return;
      }

      const adminKp = authResult.adminKeypair!;
      rollInstruction = await createRollInstruction(gamePda, playerKp.publicKey, adminKp.publicKey);
      signers = [playerKp, adminKp];
    } else {
      rollInstruction = await createRollInstruction(gamePda, playerKp.publicKey);
      signers = [playerKp];
    }

    const tx = await wallet.sendTransaction([rollInstruction], signers);
    
    const gameTypeName = getGameTypeName(gameData.game_type);
    await safeAnswerCallbackQuery(ctx, `🎲 Rolled the ${gameTypeName}!`);
    
    await handleRollConfirmation(ctx, tx, gamePda, gameAccount, gameData, game, gameData.token_mint!);
    
  } catch (error: any) {
    await handleCallbackErrorSafe(ctx, error, "game_roll", { 
      maxLength: 180,
      fallbackMessage: "Failed to roll. Please try again." 
    });
  }
};


/**
 * Create roll instruction based on whether authority is needed
 */
const createRollInstruction = async (
  gamePda: PublicKey,
  playerPubkey: PublicKey,
  authority?: PublicKey
): Promise<any> => {
  const { program } = await import("../bot");
  
  const accounts: any = {
    game: gamePda,
    player: playerPubkey,
  };
  
  if (authority) {
    accounts.authority = authority;
  }
  
  return await program.methods
    .rollGame()
    .accounts(accounts)
    .instruction();
};

/**
 * Handle post-roll confirmation and UI updates
 */
const handleRollConfirmation = async (
  ctx: any,
  tx: string,
  gamePda: PublicKey,
  gameAccount: any,
  gameData: GameData,
  game: GameData,
  tokenMint: string
): Promise<void> => {
  // Run confirmation asynchronously to avoid blocking the callback response
  (async () => {
    try {
      const { wallet, gameManager, program } = await import("../bot");
      
      await wallet.confirmTransaction(tx);

      const updatedGameAccount = await program.account.game.fetch(gamePda);
      const currentTotalPot = Number(updatedGameAccount.totalAmount || 0);

      const creatorUsername = await gameManager.getGameCreatorUsername(ctx, game.game_address);
      const gameType = formatGameType(gameAccount.gameType);
      const tokenTicker = gameData.token_ticker || "TOKEN";
      
      await gameManager.updateGameMessage(
        ctx, 
        game.game_address, 
        gameType, 
        Number(game.amount), 
        creatorUsername, 
        "Active", 
        tokenMint, 
        tokenTicker, 
        undefined, 
        currentTotalPot
      );

      await sendRollNotification(ctx, currentTotalPot, tokenMint, tokenTicker, game.game_address, gameData.game_type);
      
    } catch (error) {
      console.error("Error confirming game roll:", error);
    }
  })();
};

/**
 * Send roll notification message
 */
const sendRollNotification = async (
  ctx: any,
  totalPot: number,
  tokenMint: string,
  tokenTicker: string,
  gameAddress: string,
  gameType: string
): Promise<void> => {
  try {
    const { wallet, gameManager } = await import("../bot");
    
    const rollerUsername = ctx.from?.username || ctx.from?.first_name || "Player";
    const metadata = await wallet.getTokenMetadata(tokenMint);
    const gameMessage = gameManager.getActiveGameMessage(gameAddress);
    
    if (ctx.reply) {
      let rollMessage: string;
      if (gameType === "snowball") {
        rollMessage = `❄️ @${rollerUsername} rolled the snowball! Total pot: ${wallet.formatTokenBalance(totalPot, metadata.decimals)} ${tokenTicker}`;
      } else {
        rollMessage = `🎲 @${rollerUsername} rolled the dumbflip! Total pot: ${wallet.formatTokenBalance(totalPot, metadata.decimals)} ${tokenTicker}`;
      }

      await ctx.reply(rollMessage, {
        parse_mode: "HTML",
        reply_to_message_id: gameMessage?.messageId
      });
    }
  } catch (error) {
    console.error("Error sending roll notification:", error);
  }
};

/**
 * Get user-friendly game type name
 */
const getGameTypeName = (gameType: string): string => {
  switch (gameType) {
    case "snowball":
      return "snowball";
    case "dumbflip":
      return "dumbflip";
    default:
      return "game";
  }
};

/**
 * Format game type for display
 */
const formatGameType = (gameType: Record<string, any>): string => {
  const keys = Object.keys(gameType);
  const firstKey = keys[0];
  if (!firstKey) return "Game";
  return firstKey.charAt(0).toUpperCase() + firstKey.slice(1);
};

/**
 * Safe callback query answering
 */
const safeAnswerCallbackQuery = async (ctx: any, text: string): Promise<void> => {
  try {
    if (ctx.answerCallbackQuery) {
      await ctx.answerCallbackQuery(text);
    }
  } catch (error) {
    console.error("Failed to answer callback query:", error);
  }
};