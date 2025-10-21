import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  getAccountLenForMint,
  unpackMint,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as anchor from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import type { Timba } from "../idl/idlType";
import { WalletManager } from "../src/utils/wallet";
import { getSupportedTokens } from "../src/utils/token-registry";
import { NetworkDetector, type SolanaNetwork } from "../src/utils/network-detector";
import {
  loadKeypairFromPath,
  resolveOracleOperatorKeypair,
  uniqueSigners,
} from "./utils/keypairs";
import { createAnchorContext } from "./utils/anchor-context";

// ================================
// CONFIGURATION
// ================================

const DEFAULT_RPC_URL = "https://api.mainnet-beta.solana.com";

const resolveEnvPath = (envVar?: string, fallback?: string): string => {
  const trimmed = envVar?.trim();
  if (trimmed && trimmed.length > 0) return trimmed;
  return fallback ?? "";
};

const RPC_URL = resolveEnvPath(process.env["SOLANA_NETWORK"], DEFAULT_RPC_URL);

const resolveNetworkOverride = (value?: string): SolanaNetwork | null => {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "mainnet" || normalized === "mainnet-beta") return "mainnet";
  if (normalized === "devnet") return "devnet";
  if (normalized === "testnet") return "testnet";
  if (normalized === "localnet") return "localnet";
  return null;
};

const NETWORK_OVERRIDE = resolveNetworkOverride(process.env["SOLANA_CLUSTER"]);
const NETWORK: SolanaNetwork =
  NETWORK_OVERRIDE ?? NetworkDetector.detectNetwork(RPC_URL);
const NETWORK_DISPLAY_NAME = NetworkDetector.getNetworkDisplayName(NETWORK);

const resolveMinAmount = (envKey: string, fallback: bigint): bigint => {
  const rawValue = process.env[envKey]?.trim();
  if (!rawValue) return fallback;

  try {
    const parsed = BigInt(rawValue);
    if (parsed < 0n) {
      throw new Error(
        `${envKey} must be a non-negative integer, received ${rawValue}`
      );
    }
    return parsed;
  } catch (error) {
    throw new Error(
      `${envKey} must be a valid integer value, received ${rawValue}: ${error}`
    );
  }
};

const CONFIG = {
  RPC_URL,
  NETWORK,
  NETWORK_DISPLAY_NAME,
  ADMIN_KEYPAIR_PATH: resolveEnvPath(
    process.env["ADMIN_KEYPAIR_PATH"],
    "./admin-keypair.json"
  ),
} as const;

type TokenInitTarget = {
  tokenMint: string;
  tokenTicker: string;
  defaultMinAmount: bigint;
};

const defaultMinAmountForTicker = (ticker: string): bigint =>
  ticker.toUpperCase() === "WSOL" ? 10_000_000n : 1_000n;

const TOKEN_CONFIGS: TokenInitTarget[] = getSupportedTokens().map((token) => {
  const tickerUpper = token.ticker.toUpperCase();
  const mintEnvKey = `${tickerUpper}_MINT`;
  const tickerEnvKey = `${tickerUpper}_TICKER`;
  const minAmountEnvKey = `${tickerUpper}_DEFAULT_MIN_AMOUNT`;

  return {
    tokenMint: resolveEnvPath(process.env[mintEnvKey], token.mint),
    tokenTicker: resolveEnvPath(process.env[tickerEnvKey], token.ticker),
    defaultMinAmount: resolveMinAmount(
      minAmountEnvKey,
      defaultMinAmountForTicker(tickerUpper)
    ),
  };
});

const GAME_TOKEN_ACCOUNT_SIZE = 8 + 32 + 1 + 8 + 8 + 1; // Mirror on-chain GAME_TOKEN_SIZE
const BALANCE_BUFFER_SOL = 0.01; // Keep a small buffer to absorb fee variance

type TokenCostBreakdown =
  | {
      tokenTicker: string;
      status: "already-initialized";
      rentLamports: bigint;
      feeLamports: bigint;
      needsVaultAta: false;
    }
  | {
      tokenTicker: string;
      status: "needs-initialization";
      rentLamports: bigint;
      feeLamports: bigint;
      needsVaultAta: boolean;
    };

type InitializationCostEstimate = {
  totalLamports: bigint;
  bufferLamports: bigint;
  breakdown: TokenCostBreakdown[];
};

type FeeResponse = Awaited<ReturnType<Connection["getFeeForMessage"]>>;

const buildExplorerUrl = (resource: "tx" | "token" | "account", value: string) => {
  if (CONFIG.NETWORK === "localnet") {
    return `Explorer not available for ${CONFIG.NETWORK_DISPLAY_NAME}`;
  }

  const basePath = `${resource}/${value}`;
  if (CONFIG.NETWORK === "mainnet") {
    return `https://solscan.io/${basePath}`;
  }
  return `https://solscan.io/${basePath}?cluster=${CONFIG.NETWORK}`;
};

type BaseTokenInitializationResult = {
  tokenMint: string;
  tokenTicker: string;
  gameTokenPda: string;
  gameVaultPda: string;
};

type ExistingTokenInitializationResult = BaseTokenInitializationResult & {
  alreadyExists: true;
};

type NewTokenInitializationResult = BaseTokenInitializationResult & {
  alreadyExists: false;
  gameTokenAccount: string;
  minAmount: string;
  feeAmount: string;
  enabled: boolean;
  transaction: string;
};

type TokenInitializationResult =
  | ExistingTokenInitializationResult
  | NewTokenInitializationResult;

// ================================
// UTILITY FUNCTIONS
// ================================


const lamportsToSol = (lamports: bigint): number =>
  Number(lamports) / LAMPORTS_PER_SOL;

const formatLamports = (lamports: bigint): string =>
  lamportsToSol(lamports).toFixed(6);

const toLamportsBigInt = (value: number | null | undefined): bigint => {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return 0n;
  }
  return BigInt(Math.ceil(value));
};

const extractFeeValue = (response: FeeResponse): number => {
  if (typeof response === "number") {
    return response;
  }
  return response?.value ?? 0;
};

const estimateInitializationCosts = async (
  connection: Connection,
  program: anchor.Program<Timba>,
  adminKeypair: Keypair,
  oracleOperatorKeypair: Keypair,
  tokens: TokenInitTarget[]
): Promise<InitializationCostEstimate> => {
  const breakdown: TokenCostBreakdown[] = [];
  let requiredLamports = 0n;
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const [oraclePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("oracle")],
    program.programId
  );

  for (const { tokenMint, tokenTicker, defaultMinAmount } of tokens) {
    const mint = new PublicKey(tokenMint);

    const [gameTokenPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("game_token"), mint.toBuffer()],
      program.programId
    );
    const existingGameToken = await program.account.gameToken.fetchNullable(
      gameTokenPda
    );

    if (existingGameToken) {
      breakdown.push({
        tokenTicker,
        status: "already-initialized",
        rentLamports: 0n,
        feeLamports: 0n,
        needsVaultAta: false,
      });
      continue;
    }

    const rawGameTokenAccount = await connection.getAccountInfo(gameTokenPda);
    if (rawGameTokenAccount) {
      throw new Error(
        `${tokenTicker} GameToken account exists with incompatible structure`
      );
    }

    const mintAccount = await connection.getAccountInfo(mint);
    if (!mintAccount) {
      throw new Error(
        `❌ Token mint ${tokenMint} does not exist on ${CONFIG.NETWORK_DISPLAY_NAME}`
      );
    }

    const rentLamportsParts: bigint[] = [];
    const feeLamportsParts: bigint[] = [];

    const gameTokenRent = await connection.getMinimumBalanceForRentExemption(
      GAME_TOKEN_ACCOUNT_SIZE
    );
    rentLamportsParts.push(BigInt(gameTokenRent));

    const [gameVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("game_vault"), mint.toBuffer()],
      program.programId
    );
    const mintProgramId = mintAccount.owner;

    const gameTokenAccount = await getAssociatedTokenAddress(
      mint,
      gameVaultPda,
      true,
      mintProgramId
    );

    let needsVaultAta = false;
    const gameTokenAccountInfo = await connection.getAccountInfo(
      gameTokenAccount
    );
    if (!gameTokenAccountInfo) {
      needsVaultAta = true;
      const mintState = unpackMint(mint, mintAccount, mintProgramId);
      const ataSpace = getAccountLenForMint(mintState);
      const ataRent =
        await connection.getMinimumBalanceForRentExemption(ataSpace);
      rentLamportsParts.push(BigInt(ataRent));

      const createAtaIx = createAssociatedTokenAccountInstruction(
        adminKeypair.publicKey,
        gameTokenAccount,
        gameVaultPda,
        mint,
        mintProgramId
      );
      const createAtaTx = new Transaction({
        feePayer: adminKeypair.publicKey,
        recentBlockhash: blockhash,
      }).add(createAtaIx);
      const ataFeeResponse = await connection.getFeeForMessage(
        createAtaTx.compileMessage()
      );
      feeLamportsParts.push(toLamportsBigInt(extractFeeValue(ataFeeResponse)));
    }

    const tokenInstruction = await program.methods
      .initializeToken({
        minAmount: new anchor.BN(defaultMinAmount.toString()),
        enabled: true,
      })
      .accounts(
        {
          gameToken: gameTokenPda,
          tokenMint: mint,
          gameVault: gameVaultPda,
          gameTokenAccount,
          oracle: oraclePda,
          oracleOperator: oracleOperatorKeypair.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: mintProgramId,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        } as any
      )
      .instruction();

    const initializeTx = new Transaction({
      feePayer: adminKeypair.publicKey,
      recentBlockhash: blockhash,
    }).add(tokenInstruction);
    const initializeFeeResponse = await connection.getFeeForMessage(
      initializeTx.compileMessage()
    );
    feeLamportsParts.push(
      toLamportsBigInt(extractFeeValue(initializeFeeResponse))
    );

    const rentLamports = rentLamportsParts.reduce(
      (acc, value) => acc + value,
      0n
    );
    const feeLamports = feeLamportsParts.reduce(
      (acc, value) => acc + value,
      0n
    );

    requiredLamports += rentLamports + feeLamports;
    breakdown.push({
      tokenTicker,
      status: "needs-initialization",
      rentLamports,
      feeLamports,
      needsVaultAta,
    });
  }

  const requiresInitialization = breakdown.some(
    (entry) => entry.status === "needs-initialization"
  );
  const bufferLamports = requiresInitialization
    ? BigInt(Math.ceil(BALANCE_BUFFER_SOL * LAMPORTS_PER_SOL))
    : 0n;

  return {
    totalLamports: requiredLamports + bufferLamports,
    bufferLamports,
    breakdown,
  };
};

const ensureSufficientBalance = async (
  connection: Connection,
  keypair: Keypair,
  requiredLamports: bigint
): Promise<void> => {
  const balanceLamports = BigInt(
    await connection.getBalance(keypair.publicKey)
  );
  const solBalance = lamportsToSol(balanceLamports);
  console.log(`💰 Admin balance: ${solBalance.toFixed(6)} SOL`);

  if (requiredLamports === 0n) {
    return;
  }

  if (balanceLamports < requiredLamports) {
    const shortfall = requiredLamports - balanceLamports;
    throw new Error(
      `❌ Insufficient balance. Need at least ${formatLamports(
        requiredLamports
      )} SOL (shortfall ${formatLamports(
        shortfall
      )} SOL) to initialize pending tokens.`
    );
  }
};

// ================================
// TOKEN INITIALIZATION FUNCTIONS
// ================================

async function initializeToken(
  program: anchor.Program<Timba>,
  connection: Connection,
  adminKeypair: Keypair,
  wallet: WalletManager,
  oracleOperatorKeypair: Keypair,
  tokenMint: string,
  tokenTicker: string,
  defaultMinAmount: bigint
): Promise<TokenInitializationResult> {
  console.log(`\n🔄 Initializing ${tokenTicker} Game Token...`);

  // Validate token mint
  const mint = new PublicKey(tokenMint);
  console.log(`🪙 ${tokenTicker} Mint: ${mint.toBase58()}`);

  // Check if token mint exists
  const mintAccount = await connection.getAccountInfo(mint);
  if (!mintAccount) {
    throw new Error(
      `❌ Token mint ${tokenMint} does not exist on ${CONFIG.NETWORK_DISPLAY_NAME}`
    );
  }
  console.log(`✅ ${tokenTicker} mint verified`);
  const mintProgramId = mintAccount.owner;

  // Derive game token PDA
  const [gameTokenPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("game_token"), mint.toBuffer()],
    program.programId
  );
  console.log(`🎯 ${tokenTicker} Game Token PDA: ${gameTokenPda.toBase58()}`);

  // Derive game vault PDA
  const [gameVaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("game_vault"), mint.toBuffer()],
    program.programId
  );
  console.log(`🏦 ${tokenTicker} Game Vault PDA: ${gameVaultPda.toBase58()}`);

  const [oraclePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("oracle")],
    program.programId
  );

  // Check if game token already exists
  try {
    const existingGameToken = await program.account.gameToken.fetch(
      gameTokenPda
    );
    console.log(`⚠️  ${tokenTicker} game token already exists!`);
    console.log(`   Min Amount: ${existingGameToken.minAmount.toString()}`);
    console.log(`   Fee Amount: ${existingGameToken.feeAmount.toString()}`);
    console.log(`   Enabled: ${existingGameToken.enabled}`);
    return {
      tokenMint,
      tokenTicker,
      gameTokenPda: gameTokenPda.toBase58(),
      gameVaultPda: gameVaultPda.toBase58(),
      alreadyExists: true,
    };
  } catch (error: any) {
    // Check if account exists but has incompatible structure
    const accountInfo = await connection.getAccountInfo(gameTokenPda);
    if (accountInfo) {
      console.log(
        `⚠️  ${tokenTicker} GameToken account exists but has incompatible structure`
      );
      console.log(`   Account Owner: ${accountInfo.owner.toBase58()}`);
      console.log(`   Account Data Length: ${accountInfo.data.length} bytes`);
      console.log(`   Account Lamports: ${accountInfo.lamports}`);
      console.log(
        `\n❌ Cannot initialize new ${tokenTicker} GameToken over existing account.`
      );
      throw new Error(
        `${tokenTicker} GameToken account exists with incompatible structure`
      );
    }

    // Game token doesn't exist, proceed with initialization
    console.log(
      `📝 ${tokenTicker} game token not found, proceeding with initialization...`
    );
  }

  // Create Associated Token Account for game vault
  const gameTokenAccount = await getAssociatedTokenAddress(
    mint,
    gameVaultPda,
    true, // allowOwnerOffCurve
    mintProgramId
  );
  console.log(
    `🏪 ${tokenTicker} Game Token Account (ATA): ${gameTokenAccount.toBase58()}`
  );

  // Check if the ATA already exists, if not create it
  try {
    const accountInfo = await connection.getAccountInfo(gameTokenAccount);
    if (!accountInfo) {
      console.log(
        `🔧 Creating Associated Token Account for ${tokenTicker} game vault...`
      );

      // Create the ATA instruction
      const createAtaIx = createAssociatedTokenAccountInstruction(
        adminKeypair.publicKey, // payer
        gameTokenAccount, // ata
        gameVaultPda, // owner
        mint, // mint
        mintProgramId
      );

      // Send the ATA creation transaction
      const createAtaTx = new Transaction().add(createAtaIx);
      createAtaTx.recentBlockhash = (
        await connection.getLatestBlockhash()
      ).blockhash;
      createAtaTx.feePayer = adminKeypair.publicKey;

      const createAtaTxSignature = await connection.sendTransaction(
        createAtaTx,
        [adminKeypair]
      );
      await connection.confirmTransaction(createAtaTxSignature, "confirmed");
      console.log(
        `✅ ${tokenTicker} ATA created! Transaction: ${createAtaTxSignature}`
      );
    } else {
      console.log(`✅ ${tokenTicker} ATA already exists`);
    }
  } catch (ataError) {
    console.error(`❌ Error creating ${tokenTicker} ATA:`, ataError);
    throw ataError;
  }

  // Initialize game token
  console.log(`\n🔄 Initializing ${tokenTicker} game token...`);
  const tokenInstruction = await program.methods
    .initializeToken({
      minAmount: new anchor.BN(defaultMinAmount.toString()),
      enabled: true,
    })
    .accounts(
      {
        gameToken: gameTokenPda,
        tokenMint: mint,
        gameVault: gameVaultPda,
        gameTokenAccount,
        oracle: oraclePda,
        oracleOperator: oracleOperatorKeypair.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: mintProgramId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      } as any
    )
    .instruction();

  const tx = await wallet.sendTransaction(
    [tokenInstruction],
    uniqueSigners(adminKeypair, oracleOperatorKeypair)
  );
  console.log(`✅ ${tokenTicker} game token initialized successfully!`);

  // Verify initialization
  console.log(`\n🔍 Verifying ${tokenTicker} initialization...`);
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Retry fetching the account with exponential backoff
  let gameTokenData: any = null;
  let retries = 0;
  const maxRetries = 5;

  while (retries < maxRetries) {
    try {
      gameTokenData = await program.account.gameToken.fetch(gameTokenPda);
      break;
    } catch (error: any) {
      retries++;
      if (retries === maxRetries) {
        console.error(
          `❌ Failed to verify ${tokenTicker} account after ${maxRetries} attempts`
        );
        throw error;
      }
      console.log(
        `⏳ Attempt ${retries}/${maxRetries} - ${tokenTicker} account not found, retrying in ${
          retries * 2
        } seconds...`
      );
      await new Promise((resolve) => setTimeout(resolve, retries * 2000));
    }
  }

  if (!gameTokenData) {
    throw new Error(
      `Failed to fetch ${tokenTicker} game token data after successful initialization`
    );
  }

  return {
    tokenMint,
    tokenTicker,
    gameTokenPda: gameTokenPda.toBase58(),
    gameVaultPda: gameVaultPda.toBase58(),
    gameTokenAccount: gameTokenAccount.toBase58(),
    minAmount: gameTokenData.minAmount.toString(),
    feeAmount: gameTokenData.feeAmount.toString(),
    enabled: gameTokenData.enabled,
    transaction: tx,
    alreadyExists: false,
  };
}

// ================================
// MAIN FUNCTION
// ================================

async function initializeGameToken() {
  const tokenSummary = TOKEN_CONFIGS.map((token) => token.tokenTicker).join(", ");
  console.log(`🚀 Initializing Game Tokens (${tokenSummary})...\n`);

  // Connect to network
  const connection = new Connection(CONFIG.RPC_URL, "confirmed");
  console.log(
    `✅ Connected to ${CONFIG.NETWORK_DISPLAY_NAME} (${CONFIG.NETWORK})`
  );

  // Load admin keypair
  const adminKeypair = loadKeypairFromPath(CONFIG.ADMIN_KEYPAIR_PATH);
  console.log(`🔑 Admin keypair loaded: ${adminKeypair.publicKey.toBase58()}`);

  const oracleOperatorKeypair = resolveOracleOperatorKeypair(adminKeypair);

  const { program } = createAnchorContext(adminKeypair, {
    connection,
  });
  console.log(`📋 Program ID: ${program.programId.toBase58()}`);

  const tokensToInitialize: TokenInitTarget[] = TOKEN_CONFIGS;

  const costEstimate = await estimateInitializationCosts(
    connection,
    program,
    adminKeypair,
    oracleOperatorKeypair,
    tokensToInitialize
  );

  const needsInitialization = costEstimate.breakdown.filter(
    (entry) => entry.status === "needs-initialization"
  );

  if (needsInitialization.length > 0) {
    console.log("\n🧮 Estimated costs for pending token initialization:");
    for (const entry of costEstimate.breakdown) {
      if (entry.status === "already-initialized") {
        console.log(
          `   • ${entry.tokenTicker}: already initialized, no additional SOL required`
        );
        continue;
      }
      console.log(
        `   • ${entry.tokenTicker}: rent ${formatLamports(
          entry.rentLamports
        )} SOL, fees ${formatLamports(entry.feeLamports)} SOL${
          entry.needsVaultAta ? " (includes ATA creation)" : ""
        }`
      );
    }
    if (costEstimate.bufferLamports > 0n) {
      console.log(
        `   • Buffer: ${formatLamports(
          costEstimate.bufferLamports
        )} SOL to cover fee variance`
      );
    }
    console.log(
      `   → Total required: ${formatLamports(
        costEstimate.totalLamports
      )} SOL\n`
    );
  } else {
    console.log("✅ All configured tokens are already initialized.");
  }

  // Ensure admin wallet has enough SOL before proceeding
  await ensureSufficientBalance(
    connection,
    adminKeypair,
    costEstimate.totalLamports
  );

  // Create wallet manager for transaction sending
  const mnemonic = process.env["MNEMONIC"]?.trim();
  if (!mnemonic) {
    throw new Error("MNEMONIC env var must be set to initialize the wallet manager.");
  }

  if (!process.env["SOLANA_NETWORK"]) {
    process.env["SOLANA_NETWORK"] = CONFIG.RPC_URL;
  }

  const wallet = WalletManager.getInstance(mnemonic);

  try {
    const results: TokenInitializationResult[] = [];

    for (const tokenConfig of TOKEN_CONFIGS) {
      console.log("\n" + "=".repeat(50));
      console.log(`🎯 INITIALIZING ${tokenConfig.tokenTicker} TOKEN`);
      console.log("=".repeat(50));

      const result = await initializeToken(
        program,
        connection,
        adminKeypair,
        wallet,
        oracleOperatorKeypair,
        tokenConfig.tokenMint,
        tokenConfig.tokenTicker,
        tokenConfig.defaultMinAmount
      );
      results.push(result);
    }

    // Display comprehensive summary
    console.log("\n" + "=".repeat(60));
    console.log("🎉 INITIALIZATION COMPLETE - SUMMARY");
    console.log("=".repeat(60));

    results.forEach((result, index) => {
      const status = result.alreadyExists
        ? "Already Existed"
        : "Newly Initialized";
      console.log(`\n${index + 1}. ${result.tokenTicker} Token [${status}]:`);
      console.log(`   • Mint: ${result.tokenMint}`);
      console.log(`   • Game Token PDA: ${result.gameTokenPda}`);
      console.log(`   • Game Vault PDA: ${result.gameVaultPda}`);

      if (!result.alreadyExists) {
        console.log(`   • Game Token Account: ${result.gameTokenAccount}`);
        console.log(`   • Min Amount: ${result.minAmount}`);
        console.log(`   • Fee Amount: ${result.feeAmount}`);
        console.log(`   • Enabled: ${result.enabled}`);
        console.log(`   • Transaction: ${result.transaction}`);
      }
    });

    // Explorer links
    console.log("\n🔗 Explorer Links:");
    results.forEach((result) => {
      if (!result.alreadyExists) {
        console.log(`\n${result.tokenTicker}:`);
        console.log(`• Transaction: ${buildExplorerUrl("tx", result.transaction)}`);
        console.log(`• Token Mint: ${buildExplorerUrl("token", result.tokenMint)}`);
        console.log(
          `• Game Token PDA: ${buildExplorerUrl("account", result.gameTokenPda)}`
        );
        console.log(
          `• Game Token Account: ${buildExplorerUrl("account", result.gameTokenAccount)}`
        );
      }
    });

    // Save initialization info
    const initInfo = {
      network: CONFIG.NETWORK,
      programId: program.programId.toBase58(),
      authority: adminKeypair.publicKey.toBase58(),
      initializedAt: new Date().toISOString(),
      tokens: results.map((result) => ({
        ticker: result.tokenTicker,
        mint: result.tokenMint,
        gameTokenPda: result.gameTokenPda,
        gameVaultPda: result.gameVaultPda,
        ...(result.alreadyExists
          ? { status: "already_existed" }
          : {
              gameTokenAccount: result.gameTokenAccount,
              minAmount: result.minAmount,
              feeAmount: result.feeAmount,
              enabled: result.enabled,
              transaction: result.transaction,
              status: "newly_initialized",
            }),
      })),
    };

    const outputPath = path.join(process.cwd(), "game-tokens-info.json");
    fs.writeFileSync(outputPath, JSON.stringify(initInfo, null, 2));
    console.log(`\n💾 Initialization info saved to ${outputPath}`);
  } catch (error: any) {
    console.error("\n❌ Error initializing game tokens:", error);

    if (error.message?.includes("already in use")) {
      console.log(
        "💡 One or more game tokens may already be initialized. Check the output above."
      );
    } else if (error.message?.includes("insufficient")) {
      console.log("💡 Make sure you have enough SOL for transaction fees.");
    } else if (error.message?.includes("signature verification failed")) {
      console.log(
        "💡 Make sure the admin keypair has the correct permissions."
      );
    }

    throw error;
  }
}

// ================================
// SCRIPT EXECUTION
// ================================

if (require.main === module) {
  initializeGameToken()
    .then(() => {
      console.log("\n✅ Game tokens initialization completed successfully!");
      process.exit(0);
    })
    .catch((error) => {
      console.error("\n❌ Failed to initialize game tokens:", error);
      process.exit(1);
    });
}

export { initializeGameToken, initializeToken, CONFIG };
