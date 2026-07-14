import * as anchor from "@anchor-lang/core";
import { getAssociatedTokenAddressSync, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, Keypair, sendAndConfirmRawTransaction, type Connection } from "@solana/web3.js";
import { ReferralProvider } from "@jup-ag/referral-sdk";
import type { Timba } from "../../idl/idlType";
import { WalletManager } from "../utils/wallet";
import { loadWalletMnemonic } from "../utils/secrets";
import {
  getSupportedTokens,
  type TokenConfig,
  getReferralTokenEntries,
  type ReferralTokenConfigEntry,
  WSOL_MINT,
} from "../utils/token-registry";
import { resolvePrimaryRpcEndpoint } from "../utils/rpc-endpoints";
import { getCachedPriceLookup, getUsdPrice } from "../utils/price-service";
import {
  FEE_SWEEP_SOL_USD_THRESHOLD,
  LAMPORTS_PER_SOL,
  FEE_SWEEP_SOL_PRICE_MAX_AGE_MS,
  FEE_SWEEP_SOL_PRICE_MAX_DRIFT_RATIO,
} from "../utils/constants";
import {
  bundleFromKeypair,
  resolveOracleOperatorBundle,
  uniqueSigners,
  type KeypairBundle,
} from "../../scripts/utils/keypairs";
import { createAnchorContext } from "../../scripts/utils/anchor-context";
import { SwapManager } from "../utils/swap-manager";
import type { SwapRequest } from "../utils/swap/types";

export interface FeeSweepOptions {
  rpcUrl?: string;
  walletManager?: WalletManager;
  tokenConfigs?: TokenConfig[];
  referralEntries?: ReferralTokenConfigEntry[];
  enableSwapToSol?: boolean;
  solUsdThreshold?: number;
  swapManagerFactory?: (
    connection: Connection,
    wallet: WalletManager,
  ) => SwapManager | Pick<SwapManager, "getQuote" | "executeJupiterSwap">;
  priceResolver?: PriceResolver;
  balanceFetcher?: TokenBalanceFetcher;
  tokenFeeProcessor?: typeof processTokenFee;
  referralSweeper?: typeof runReferralSweep;
  tokenToSolSweeper?: typeof sweepTokensToSol;
  contextFactory?: typeof createAnchorContext;
}

export interface FeeSweepResult {
  tokenWithdrawals: number;
  referralClaims: number;
}

type PriceResolver = typeof getUsdPrice;
type TokenBalanceFetcher = (
  connection: Connection,
  owner: PublicKey,
  mint: PublicKey,
) => Promise<bigint>;

type SolPriceData = {
  price?: number;
  resolvedAt?: number;
  timestamp?: number;
};

const MIN_USD_THRESHOLD = 5;
const SOL_DECIMALS = 9;

const normalizeTimestampMs = (timestamp: number): number => {
  if (!Number.isFinite(timestamp)) return timestamp;
  return timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp;
};

const validateSolPriceData = (
  priceData: SolPriceData | null | undefined,
  options: {
    maxAgeMs?: number;
    previousPrice?: number;
    maxDriftRatio?: number;
  } = {},
): { isValid: boolean; reason?: string } => {
  const solPrice = priceData?.price ?? 0;
  if (!Number.isFinite(solPrice) || solPrice <= 0) {
    return { isValid: false, reason: "missing or non-positive price" };
  }

  const timestamp =
    typeof priceData?.resolvedAt === "number"
      ? priceData.resolvedAt
      : typeof priceData?.timestamp === "number"
        ? priceData.timestamp
        : null;

  if (timestamp === null) {
    return { isValid: false, reason: "missing timestamp" };
  }

  const { maxAgeMs, previousPrice, maxDriftRatio } = options;
  if (maxAgeMs) {
    const now = Date.now();
    const normalizedTimestamp = normalizeTimestampMs(timestamp);
    if (now - normalizedTimestamp > maxAgeMs) {
      return { isValid: false, reason: "stale timestamp" };
    }
  }

  if (
    typeof previousPrice === "number" &&
    Number.isFinite(previousPrice) &&
    previousPrice > 0 &&
    typeof maxDriftRatio === "number" &&
    Number.isFinite(maxDriftRatio) &&
    maxDriftRatio > 0
  ) {
    const driftRatio = Math.abs(solPrice - previousPrice) / previousPrice;
    if (driftRatio > maxDriftRatio) {
      return {
        isValid: false,
        reason: `price drift ${(driftRatio * 100).toFixed(2)}% exceeds ${(
          maxDriftRatio * 100
        ).toFixed(2)}%`,
      };
    }
  }

  return { isValid: true };
};

const getSolBalanceUsdValue = async (
  connection: Connection,
  owner: PublicKey,
  priceResolver: PriceResolver = getUsdPrice,
) => {
  const [lamports, solPriceData] = await Promise.all([
    connection.getBalance(owner),
    priceResolver({ tokenMint: WSOL_MINT }),
  ]);
  const solPrice = solPriceData?.price ?? 0;
  const usdValue = lamports > 0 && solPrice > 0 ? (lamports / LAMPORTS_PER_SOL) * solPrice : 0;
  return { lamports, usdValue, solPrice, solPriceData };
};

const shouldSkipTokenToSolSweeps = async (options: {
  connection: Connection;
  wallet: WalletManager;
  owner: PublicKey;
  solUsdThreshold: number;
  priceResolver?: PriceResolver;
}): Promise<boolean> => {
  const { connection, wallet, owner, solUsdThreshold, priceResolver } = options;
  const cachedSolPrice = getCachedPriceLookup({ tokenMint: WSOL_MINT });
  const { lamports, usdValue, solPriceData } = await getSolBalanceUsdValue(
    connection,
    owner,
    priceResolver,
  );

  const { isValid, reason } = validateSolPriceData(solPriceData, {
    maxAgeMs: FEE_SWEEP_SOL_PRICE_MAX_AGE_MS,
    previousPrice: cachedSolPrice?.price,
    maxDriftRatio: FEE_SWEEP_SOL_PRICE_MAX_DRIFT_RATIO,
  });
  if (!isValid) {
    console.warn(
      `⚠️  skipping due to unreliable SOL price${
        reason ? ` (${reason})` : ""
      }; skipping token-to-SOL sweeps.`,
    );
    return true;
  }

  if (usdValue >= solUsdThreshold) {
    console.log(
      `ℹ️  SOL balance ${wallet.formatSolBalance(
        lamports,
      )} ≈ $${usdValue.toFixed(2)} (>= $${solUsdThreshold}); skipping token-to-SOL sweeps.`,
    );
    return true;
  }

  return false;
};

const shouldWithdrawToken = async (
  wallet: WalletManager,
  config: TokenConfig,
  pendingFees: bigint,
  decimals: number,
  priceResolver: PriceResolver = getUsdPrice,
) => {
  const formattedPending = wallet.formatTokenBalance(Number(pendingFees), decimals);
  const tokenAmount = Number(pendingFees) / 10 ** decimals;
  const priceData = await priceResolver({
    tokenMint: config.mint,
  });
  const tokenUsdValue = tokenAmount * (priceData?.price ?? 0);
  if (tokenUsdValue < MIN_USD_THRESHOLD) {
    console.log(
      `ℹ️  Skipping ${config.ticker} withdrawal: ${formattedPending} ≈ $${tokenUsdValue.toFixed(
        2,
      )} (< $${MIN_USD_THRESHOLD}).`,
    );
    return { shouldWithdraw: false, formattedPending, tokenUsdValue };
  }
  return { shouldWithdraw: true, formattedPending, tokenUsdValue };
};

const getTotalTokenBalanceLamports: TokenBalanceFetcher = async (connection, owner, mint) => {
  let total = 0n;
  const parsed = await connection.getParsedTokenAccountsByOwner(owner, {
    mint,
  });
  for (const acc of parsed.value) {
    const amountStr = acc.account.data.parsed.info.tokenAmount.amount as string;
    total += BigInt(amountStr);
  }
  return total;
};

const shouldSwapTokenBalance = async (
  config: TokenConfig,
  lamports: bigint,
  decimals: number,
  priceResolver: PriceResolver = getUsdPrice,
) => {
  const amountDecimal = Number(lamports) / 10 ** decimals;
  const price = await priceResolver({
    tokenMint: config.mint,
  });
  const usdValue = amountDecimal * (price?.price ?? 0);
  if (usdValue < MIN_USD_THRESHOLD) {
    console.log(
      `ℹ️  ${config.ticker} balance ${amountDecimal.toFixed(6)} ≈ $${usdValue.toFixed(
        2,
      )}; skipping (<$${MIN_USD_THRESHOLD}).`,
    );
    return { shouldSwap: false, amountDecimal, usdValue };
  }

  return { shouldSwap: true, amountDecimal, usdValue };
};

const unwrapWsolBalance = async (
  wallet: WalletManager,
  connection: Connection,
  owner: PublicKey,
  payer: Keypair,
  priceResolver: PriceResolver = getUsdPrice,
  balanceFetcher: TokenBalanceFetcher = getTotalTokenBalanceLamports,
) => {
  const wsolMint = new PublicKey(WSOL_MINT);
  const wsolBalanceLamports = await balanceFetcher(connection, owner, wsolMint);

  if (wsolBalanceLamports === 0n) {
    console.log("ℹ️  No WSOL balance to unwrap; skipping.");
    return;
  }

  const metadata = await wallet.getTokenMetadata(WSOL_MINT);
  const amountDecimal = Number(wsolBalanceLamports) / 10 ** metadata.decimals;
  const price = await priceResolver({ tokenMint: WSOL_MINT });
  const usdValue = amountDecimal * (price?.price ?? 0);

  if (usdValue < MIN_USD_THRESHOLD) {
    console.log(
      `ℹ️  WSOL balance ${amountDecimal.toFixed(6)} ≈ $${usdValue.toFixed(
        2,
      )}; skipping unwrap (<$${MIN_USD_THRESHOLD}).`,
    );
    return;
  }

  if (!Number.isSafeInteger(Number(wsolBalanceLamports))) {
    console.warn("⚠️  WSOL balance exceeds safe integer range; skipping unwrap.");
    return;
  }

  console.log(`➡️  Unwrapping ${amountDecimal.toFixed(6)} WSOL (~$${usdValue.toFixed(2)}) to SOL`);

  const { signature, remainingLamports } = await wallet.unwrapSolWithKeypair({
    owner,
    payer,
    amountLamports: Number(wsolBalanceLamports),
  });

  const remainingDecimal = remainingLamports / 10 ** SOL_DECIMALS;

  console.log(
    `   ✅ Unwrapped WSOL. Remaining WSOL: ${remainingDecimal.toFixed(6)}. Signature: ${signature}`,
  );
};

async function processTokenFee(
  program: anchor.Program<Timba>,
  connection: Connection,
  wallet: WalletManager,
  adminBundle: KeypairBundle,
  operatorBundle: KeypairBundle,
  config: TokenConfig,
  priceResolver: PriceResolver,
): Promise<boolean> {
  const mint = new PublicKey(config.mint);
  const [oraclePda] = PublicKey.findProgramAddressSync([Buffer.from("oracle")], program.programId);
  const [gameTokenPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("game_token"), mint.toBuffer()],
    program.programId,
  );
  const [gameVaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("game_vault"), mint.toBuffer()],
    program.programId,
  );

  const gameTokenInfo = await connection.getAccountInfo(gameTokenPda);
  if (!gameTokenInfo) {
    console.warn(`⚠️  No game token configuration found for ${config.ticker}; skipping.`);
    return false;
  }

  const gameToken = await program.account.gameToken.fetch(gameTokenPda);
  const pendingFees = BigInt(gameToken.feeAmount.toString());
  if (pendingFees === 0n) {
    console.log(`ℹ️  No pending fees for ${config.ticker}; skipping.`);
    return false;
  }

  const metadata = await wallet.getTokenMetadata(config.mint);
  const { shouldWithdraw, formattedPending } = await shouldWithdrawToken(
    wallet,
    config,
    pendingFees,
    metadata.decimals,
    priceResolver,
  );
  if (!shouldWithdraw) return false;

  const {
    address: operatorAta,
    instructions: operatorAtaInstructions,
    programId: tokenProgramId,
    created: operatorAtaCreated,
  } = await wallet.ensureAssociatedTokenAccount(
    operatorBundle.anchor.publicKey,
    mint,
    adminBundle.root,
  );
  const gameVaultAta = getAssociatedTokenAddressSync(
    mint,
    gameVaultPda,
    true,
    tokenProgramId,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  console.log(
    `➡️  Withdrawing ${formattedPending} ${
      config.ticker
    } to ${operatorBundle.anchor.publicKey.toBase58()}`,
  );

  const instruction = await program.methods
    .withdrawTokenFee()
    .accounts({
      oracle: oraclePda,
      oracleOperator: operatorBundle.anchor.publicKey,
      oracleOperatorTokenAccount: operatorAta,
      gameTokenCtx: {
        tokenMint: mint,
        gameToken: gameTokenPda,
        gameVault: gameVaultPda,
        gameTokenAccount: gameVaultAta,
        tokenProgram: tokenProgramId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      },
    } as any)
    .instruction();
  const instructions = [...operatorAtaInstructions, instruction];

  if (operatorAtaCreated) {
    console.log(`🔧 Created oracle operator ATA ${operatorAta.toBase58()} for ${config.ticker}`);
  }

  const tx = await wallet.sendAndConfirmWithResubmits(
    instructions,
    uniqueSigners(adminBundle.root, operatorBundle.root),
    { operationLabel: `Withdraw ${config.ticker} fees` },
  );

  console.log(`   ✅ Withdrawn. Transaction: ${tx}`);
  return true;
}

async function runReferralSweep(
  connection: Connection,
  adminBundle: KeypairBundle,
  referralEntries: ReferralTokenConfigEntry[],
  priceResolver: PriceResolver = getUsdPrice,
): Promise<number> {
  if (referralEntries.length === 0) {
    console.log("ℹ️  No referral entries configured; skipping referral claims.");
    return 0;
  }

  const referralEntry = referralEntries[0];
  if (!referralEntry?.referralAccount) {
    console.log("ℹ️  No referral account configured; skipping referral claims.");
    return 0;
  }

  const referralAccount = new PublicKey(referralEntry.referralAccount);
  const provider = new ReferralProvider(connection as unknown as Connection);

  console.log("💸 Checking Jupiter referral fees...");

  // Get all referral token accounts and calculate total USD value
  const referralTokenAccountsResult = await provider.getReferralTokenAccounts(
    referralAccount.toBase58(),
  );
  const allTokenAccounts = [
    ...referralTokenAccountsResult.tokenAccounts,
    ...referralTokenAccountsResult.token2022Accounts,
  ];

  if (!allTokenAccounts.length) {
    console.log("ℹ️  No referral token accounts found.");
    return 0;
  }

  let totalUsdValue = 0;
  for (const tokenAccount of allTokenAccounts) {
    const mint = tokenAccount.account.mint.toBase58();
    const amount = tokenAccount.account.amount;
    if (amount === 0n) continue;

    // Try to get price for this token
    const priceData = await priceResolver({ tokenMint: mint });
    if (!priceData?.price) continue;

    // Fetch decimals for this token
    const mintInfo = await connection.getParsedAccountInfo(tokenAccount.account.mint);
    const decimals =
      mintInfo.value &&
      "parsed" in mintInfo.value.data &&
      mintInfo.value.data.parsed?.info?.decimals != null
        ? mintInfo.value.data.parsed.info.decimals
        : 9;

    const tokenAmount = Number(amount) / 10 ** decimals;
    totalUsdValue += tokenAmount * priceData.price;
  }

  if (totalUsdValue < MIN_USD_THRESHOLD) {
    console.log(
      `ℹ️  Skipping referral claim: total value ≈ $${totalUsdValue.toFixed(2)} (< $${MIN_USD_THRESHOLD}).`,
    );
    return 0;
  }

  console.log(`💸 Collecting Jupiter referral fees (~$${totalUsdValue.toFixed(2)})...`);

  const transactions = await provider.claimAllV2({
    payerPubKey: adminBundle.anchor.publicKey,
    referralAccountPubKey: referralAccount,
  });

  if (!transactions.length) {
    console.log("ℹ️  No referral fee transactions to claim.");
    return 0;
  }

  console.log(`🧾 Found ${transactions.length} referral transaction(s). Processing...`);

  let processedClaims = 0;
  for (let i = 0; i < transactions.length; i++) {
    const tx = transactions[i];
    if (!tx) continue;
    tx.sign([adminBundle.anchor]);
    const sig = await sendAndConfirmRawTransaction(
      connection as unknown as Connection,
      Buffer.from(tx.serialize()),
    );
    processedClaims += 1;
    console.log(`   ✅ Referral claim ${i + 1}/${transactions.length}: ${sig}`);
  }

  return processedClaims;
}

async function sweepTokensToSol(
  wallet: WalletManager,
  connection: Connection,
  tokens: TokenConfig[],
  swapManagerFactory: Required<FeeSweepOptions>["swapManagerFactory"],
  solUsdThreshold: number,
  priceResolver: PriceResolver = getUsdPrice,
  balanceFetcher: TokenBalanceFetcher = getTotalTokenBalanceLamports,
) {
  const admin = wallet.getAdminKeypair();
  const swapManager = swapManagerFactory(connection, wallet);
  const sweepableTokens = tokens.filter(
    (token) => token.mint !== WSOL_MINT && token.ticker !== "SOL",
  );

  if (sweepableTokens.length === 0) {
    console.log("ℹ️  No sweepable tokens configured; skipping swaps.");
    return;
  }

  const shouldSkip = await shouldSkipTokenToSolSweeps({
    connection,
    wallet,
    owner: admin.publicKey,
    solUsdThreshold,
    priceResolver,
  });
  if (shouldSkip) {
    return;
  }

  console.log("\n💱 Sweeping eligible token balances to SOL (>$5 value)...\n");

  for (const token of sweepableTokens) {
    try {
      const mintPubkey = new PublicKey(token.mint);
      const balanceLamports = await balanceFetcher(connection, admin.publicKey, mintPubkey);

      if (balanceLamports === 0n) {
        console.log(`ℹ️  No balance for ${token.ticker}; skipping.`);
        continue;
      }

      const metadata = await wallet.getTokenMetadata(token.mint);
      const { shouldSwap, amountDecimal, usdValue } = await shouldSwapTokenBalance(
        token,
        balanceLamports,
        metadata.decimals,
        priceResolver,
      );

      if (!shouldSwap) continue;

      console.log(
        `➡️  Swapping ${amountDecimal.toFixed(6)} ${token.ticker} (~$${usdValue.toFixed(
          2,
        )}) to SOL`,
      );

      const swapRequest: SwapRequest = {
        inputMint: token.mint,
        outputMint: WSOL_MINT,
        amount: balanceLamports.toString(),
        userKeypair: admin as any,
        inputDecimals: metadata.decimals,
        outputDecimals: 9,
        inputTicker: token.ticker,
        outputTicker: "SOL",
      } as SwapRequest;

      const quote = await swapManager.getQuote(swapRequest as any);
      const sig = await (swapManager as any).executeJupiterSwap(swapRequest as any, quote);
      console.log(`   ✅ Swap submitted: ${sig}`);
    } catch (error) {
      console.error(`❌ Failed to sweep ${token.ticker}:`, error);
    }
  }

  console.log("\n🏁 Sweep complete.\n");
}

export const sweepFees = async (options: FeeSweepOptions = {}): Promise<FeeSweepResult> => {
  console.log("💸 Collecting oracle fees for configured tokens...\n");

  const wallet = options.walletManager ?? WalletManager.getInstance(loadWalletMnemonic());
  const adminRoot = wallet.getAdminKeypair();
  const adminBundle = bundleFromKeypair(adminRoot);
  const operatorBundle = resolveOracleOperatorBundle(adminRoot);

  const tokens = options.tokenConfigs ?? getSupportedTokens();
  const referralEntries = options.referralEntries ?? getReferralTokenEntries();
  const rpcUrl = resolvePrimaryRpcEndpoint(options.rpcUrl ?? process.env.SOLANA_NETWORK);
  const priceResolver = options.priceResolver ?? getUsdPrice;
  const swapManagerFactory =
    options.swapManagerFactory ??
    ((connection: Connection, walletManager: WalletManager) =>
      new SwapManager(connection as any, walletManager));
  const balanceFetcher = options.balanceFetcher ?? getTotalTokenBalanceLamports;
  const enableSwapToSol = options.enableSwapToSol ?? true;
  const tokenFeeProcessor = options.tokenFeeProcessor ?? processTokenFee;
  const referralSweeper = options.referralSweeper ?? runReferralSweep;
  const tokenToSolSweeper = options.tokenToSolSweeper ?? sweepTokensToSol;
  const contextFactory = options.contextFactory ?? createAnchorContext;
  const solUsdThreshold =
    typeof options.solUsdThreshold === "number" &&
    Number.isFinite(options.solUsdThreshold) &&
    options.solUsdThreshold > 0
      ? options.solUsdThreshold
      : FEE_SWEEP_SOL_USD_THRESHOLD;

  const { provider, program } = contextFactory(adminBundle.root, {
    rpcUrl,
  });
  const connection = provider.connection as unknown as Connection;

  console.log(`Program ID: ${program.programId.toBase58()}`);
  console.log(
    `Admin payer: ${adminBundle.anchor.publicKey.toBase58()}, Oracle operator: ${operatorBundle.anchor.publicKey.toBase58()}`,
  );

  let tokenWithdrawals = 0;
  for (const token of tokens) {
    try {
      const withdrawn = await tokenFeeProcessor(
        program,
        connection,
        wallet,
        adminBundle,
        operatorBundle,
        token,
        priceResolver,
      );
      if (withdrawn) {
        tokenWithdrawals += 1;
      }
    } catch (error) {
      console.error(`❌ Failed withdrawing ${token.ticker}:`, error);
    }
  }

  let referralClaims = 0;
  try {
    referralClaims = await referralSweeper(connection, adminBundle, referralEntries, priceResolver);
  } catch (error) {
    console.error("❌ Failed withdrawing referral fees:", error);
  }

  if (enableSwapToSol) {
    try {
      const shouldSkip = await shouldSkipTokenToSolSweeps({
        connection,
        wallet,
        owner: adminBundle.root.publicKey,
        solUsdThreshold,
        priceResolver,
      });
      if (!shouldSkip) {
        await tokenToSolSweeper(
          wallet,
          connection,
          tokens,
          swapManagerFactory,
          solUsdThreshold,
          priceResolver,
          balanceFetcher,
        );
        await unwrapWsolBalance(
          wallet,
          connection,
          adminBundle.root.publicKey,
          adminBundle.root,
          priceResolver,
          balanceFetcher,
        );
      }
    } catch (error) {
      console.error("❌ Failed to sweep tokens to SOL:", error);
    }
  } else {
    console.log("ℹ️  Token-to-SOL sweep disabled; skipping swaps.");
  }

  console.log("\n🏁 Fee withdrawal run completed.");

  return { tokenWithdrawals, referralClaims };
};

export const __test_shouldWithdrawToken = shouldWithdrawToken;
export const __test_shouldSwapTokenBalance = shouldSwapTokenBalance;
export const __test_sweepTokensToSol = sweepTokensToSol;
export const __test_unwrapWsolBalance = unwrapWsolBalance;
export const __test_runReferralSweep = runReferralSweep;
export { unwrapWsolBalance };
