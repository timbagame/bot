import * as anchor from "@coral-xyz/anchor";
import { Keypair as Web3Keypair } from "@solana/web3.js";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import * as fs from "fs";
import * as path from "path";
import type { Timba } from "../idl/idlType";
import idl from "../idl/idl.json";
import { WalletManager } from "../src/utils/wallet";
import { getPriceUSD } from "../src/utils/prices";

const ORACLE_OPERATOR_KEYPAIR_ENV = "ORACLE_OPERATOR_KEYPAIR_PATH";

const RPC_URL =
  process.env["SOLANA_NETWORK"] || "https://api.mainnet-beta.solana.com";

const DEFAULT_COMPLETION_COMPUTE_UNITS = BigInt(
  process.env["COMPLETION_COMPUTE_UNITS"] ?? 200_000
);
const DEFAULT_COMPLETION_SIGNATURES = BigInt(
  process.env["COMPLETION_SIGNATURES"] ?? 1
);
const DEFAULT_MARGIN_MULTIPLIER = Number(
  process.env["MIN_BET_MARGIN_MULTIPLIER"] ?? "1.2"
);

type TokenTarget = {
  mint: string;
  ticker: string;
  minCompletionFeeLamports?: bigint;
};

const TARGET_TOKENS: TokenTarget[] = [
  {
    mint: "F3A1baCgv4TF79TSjdMTvpMDtNv8DJvHZwNc9DG8pump", // TIMBA mainnet
    ticker: "TIMBA",
    minCompletionFeeLamports: process.env["TIMBA_MIN_COMPLETION_FEE_LAMPORTS"]
      ? BigInt(process.env["TIMBA_MIN_COMPLETION_FEE_LAMPORTS"]!)
      : undefined,
  },
  {
    mint: "So11111111111111111111111111111111111111112", // WSOL
    ticker: "WSOL",
    minCompletionFeeLamports: process.env["WSOL_MIN_COMPLETION_FEE_LAMPORTS"]
      ? BigInt(process.env["WSOL_MIN_COMPLETION_FEE_LAMPORTS"]!)
      : undefined,
  },
];

type KeypairBundle = {
  root: Web3Keypair;
  anchor: anchor.web3.Keypair;
};

const bundleFromSecret = (secret: Uint8Array): KeypairBundle => ({
  root: Web3Keypair.fromSecretKey(secret),
  anchor: anchor.web3.Keypair.fromSecretKey(secret),
});

const bundleFromRoot = (keypair: Web3Keypair): KeypairBundle =>
  bundleFromSecret(keypair.secretKey);

const loadKeypairBundle = (filePath: string): KeypairBundle => {
  const resolved = path.isAbsolute(filePath)
    ? filePath
    : path.join(process.cwd(), filePath);
  const raw = JSON.parse(fs.readFileSync(resolved, "utf-8"));
  return bundleFromSecret(new Uint8Array(raw));
};

const resolveOracleOperatorKeypair = (
  fallback: Web3Keypair
): KeypairBundle => {
  const configuredPath = process.env[ORACLE_OPERATOR_KEYPAIR_ENV]?.trim();
  if (!configuredPath) {
    console.log(
      "ORACLE_OPERATOR_KEYPAIR_PATH not set; using admin keypair as oracle operator."
    );
    return bundleFromRoot(fallback);
  }

  const bundle = loadKeypairBundle(configuredPath);
  console.log(
    `Oracle operator signer loaded from ${configuredPath}: ${bundle.root.publicKey.toBase58()}`
  );
  return bundle;
};

const uniqueSigners = (...signers: Web3Keypair[]): Web3Keypair[] => {
  const seen = new Set<string>();
  const deduped: Web3Keypair[] = [];
  for (const signer of signers) {
    const key = signer.publicKey.toBase58();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(signer);
  }
  return deduped;
};

async function estimateCompletionCostLamports(
  connection: anchor.web3.Connection
): Promise<bigint> {
  let lamportsPerSignature = 5000n;
  try {
    const { blockhash } = await connection.getLatestBlockhash();
    const feeCalc = await connection.getFeeCalculatorForBlockhash(blockhash);
    const maybeFee = feeCalc?.value?.lamportsPerSignature;
    if (typeof maybeFee === "number") {
      lamportsPerSignature = BigInt(maybeFee);
    }
  } catch (error) {
    console.warn("⚠️  Failed to fetch base fee; using default 5000 lamports.", error);
  }

  let priorityFeeLamports = 0n;
  try {
    const samples = await connection.getRecentPrioritizationFees();
    const medianIndex = samples.length > 0 ? Math.floor(samples.length / 2) : 0;
    const sample = samples?.[medianIndex]?.prioritizationFee ?? 0;
    const perComputeUnit = BigInt(Math.max(sample ?? 0, 0));
    priorityFeeLamports = perComputeUnit * DEFAULT_COMPLETION_COMPUTE_UNITS;
  } catch (error) {
    console.warn("⚠️  Failed to fetch prioritization fees; assuming zero.", error);
  }

  const signatureCost =
    lamportsPerSignature * DEFAULT_COMPLETION_SIGNATURES;
  return signatureCost + priorityFeeLamports;
}

const SOL_LAMPORTS = 1_000_000_000;

type Proposal = {
  mint: string;
  ticker: string;
  decimals: number;
  currentMinAmount: bigint;
  currentFee: bigint;
  requiredMinAmount: bigint;
  newFee: bigint;
  updateNeeded: boolean;
  tokenPriceUSD: number;
};

async function buildProposal(
  program: anchor.Program<Timba>,
  connection: anchor.web3.Connection,
  wallet: WalletManager,
  oracleFeePercentage: bigint,
  completionCostLamports: bigint,
  solPriceUSD: number,
  target: TokenTarget
): Promise<Proposal | null> {
  const mint = new anchor.web3.PublicKey(target.mint);
  const [gameTokenPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("game_token"), mint.toBuffer()],
    program.programId
  );

  const accountInfo = await connection.getAccountInfo(gameTokenPda);
  if (!accountInfo) {
    console.warn(
      `⚠️  Game token account not found for ${target.ticker}. Skipping.`
    );
    return null;
  }

  const gameToken = await program.account.gameToken.fetch(gameTokenPda);
  const metadata = await wallet.getTokenMetadata(target.mint);
  const tokenPriceUSD =
    (await getPriceUSD(target.mint)) || (await getPriceUSD(target.ticker));

  const currentMinAmount = BigInt(gameToken.minAmount.toString());
  const currentFee =
    (currentMinAmount * oracleFeePercentage) / 100n;

  const tokenCompletionCostLamports =
    target.minCompletionFeeLamports ?? completionCostLamports;

  const effectiveCompletionCostUSD =
    tokenCompletionCostLamports === 0n
      ? 0
      : (Number(tokenCompletionCostLamports) / SOL_LAMPORTS) * solPriceUSD;

  let costInTokenRaw = 0n;
  if (tokenPriceUSD > 0) {
    const costInToken =
      effectiveCompletionCostUSD / tokenPriceUSD; // token amount
    const raw =
      Math.ceil(costInToken * Math.pow(10, metadata.decimals));
    costInTokenRaw = BigInt(raw);
  } else {
    // fallback: use completion cost in lamports converted by decimals ratio
    const scale = 10n ** BigInt(metadata.decimals);
    const ratio =
      (scale * tokenCompletionCostLamports) /
      BigInt(SOL_LAMPORTS);
    costInTokenRaw = ratio;
  }

  const marginMultiplier =
    DEFAULT_MARGIN_MULTIPLIER > 1 ? DEFAULT_MARGIN_MULTIPLIER : 1.0;
  const costRawNumber = Number(costInTokenRaw);
  const marginAdjustedCostNumber = Math.ceil(costRawNumber * marginMultiplier);
  const requiredMinNumber = Math.ceil(
    (marginAdjustedCostNumber * 100) / Number(oracleFeePercentage || 1n)
  );
  const requiredMinAmount = BigInt(requiredMinNumber);

  const proposedMinAmount =
    requiredMinAmount > currentMinAmount
      ? requiredMinAmount
      : currentMinAmount;

  const newFee =
    (proposedMinAmount * oracleFeePercentage) / 100n;

  return {
    mint: target.mint,
    ticker: target.ticker,
    decimals: metadata.decimals,
    currentMinAmount,
    currentFee,
    requiredMinAmount: proposedMinAmount,
    newFee,
    updateNeeded: proposedMinAmount > currentMinAmount,
    tokenPriceUSD,
  };
}

async function confirm(prompt: string): Promise<boolean> {
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(`${prompt} (y/N): `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function main() {
  console.log("⚙️  Calibrating minimum bet sizes...\n");

  const wallet = WalletManager.getInstance(process.env.MNEMONIC!);
  const adminRoot = wallet.getAdminKeypair();
  const adminBundle = bundleFromRoot(adminRoot);
  const oracleOperatorBundle = resolveOracleOperatorKeypair(adminRoot);

  const connection = new anchor.web3.Connection(RPC_URL, "confirmed");
  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(adminBundle.anchor),
    { commitment: "confirmed" }
  );
  anchor.setProvider(provider);

  const program = new anchor.Program(
    idl as Timba,
    provider
  ) as anchor.Program<Timba>;

  console.log(`Program ID: ${program.programId.toBase58()}`);
  console.log(
    `Admin signer: ${adminBundle.anchor.publicKey.toBase58()}, Oracle operator signer: ${oracleOperatorBundle.anchor.publicKey.toBase58()}`
  );

  const completionCostLamports = await estimateCompletionCostLamports(connection);
  const solPriceUSD = await getPriceUSD("SOL");
  const completionCostSOL =
    Number(completionCostLamports) / SOL_LAMPORTS;
  const completionCostUSD = completionCostSOL * solPriceUSD;

  console.log("\n🔍 Estimated completion cost:");
  console.log(`   Base + priority fees: ${completionCostLamports} lamports (~${completionCostSOL.toFixed(6)} SOL)`);
  console.log(`   SOL price (USD): ${solPriceUSD.toFixed(4)}`);
  console.log(`   Estimated USD cost per completion: $${completionCostUSD.toFixed(4)}`);
  console.log(`   Margin multiplier: x${DEFAULT_MARGIN_MULTIPLIER}`);

  const [oraclePda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("oracle")],
    program.programId
  );
  const oracleAccount = await program.account.oracle.fetch(oraclePda);
  const oracleFeePercentage = BigInt(oracleAccount.feePercentage);

  if (oracleFeePercentage === 0n) {
    throw new Error("Oracle fee percentage is zero; cannot compute minimums.");
  }

  const proposals: Proposal[] = [];
  for (const target of TARGET_TOKENS) {
    const proposal = await buildProposal(
      program,
      connection,
      wallet,
      oracleFeePercentage,
      completionCostLamports,
      solPriceUSD,
      target
    );
    if (proposal) proposals.push(proposal);
  }

  if (proposals.length === 0) {
    console.log("\nNo tokens require updates. Exiting.");
    return;
  }

  console.log("\n📊 Proposed adjustments:");
  for (const proposal of proposals) {
    const formatter = (amount: bigint, decimals: number) =>
      wallet.formatTokenBalance(Number(amount), decimals);
    console.log(`\nToken ${proposal.ticker} (${proposal.mint})`);
    console.log(`   Token price: $${proposal.tokenPriceUSD.toFixed(4)}`);
    console.log(
      `   Current min: ${proposal.currentMinAmount} raw (~${formatter(
        proposal.currentMinAmount,
        proposal.decimals
      )})`
    );
    console.log(
      `   Current fee (1%): ${proposal.currentFee} raw (~${formatter(
        proposal.currentFee,
        proposal.decimals
      )})`
    );
    console.log(
      `   Proposed min: ${proposal.requiredMinAmount} raw (~${formatter(
        proposal.requiredMinAmount,
        proposal.decimals
      )})`
    );
    console.log(
      `   Proposed fee (1%): ${proposal.newFee} raw (~${formatter(
        proposal.newFee,
        proposal.decimals
      )})`
    );
    console.log(
      `   Needs update: ${proposal.updateNeeded ? "YES" : "no"}`
    );
  }

  if (!proposals.some((p) => p.updateNeeded)) {
    console.log("\nAll tokens already satisfy the fee threshold. No updates applied.");
    return;
  }

  const proceed = await confirm(
    "\nApply the proposed minimum bet updates?"
  );
  if (!proceed) {
    console.log("Aborting without changes.");
    return;
  }

  console.log("\n🛠  Applying updates...");
  const [oraclePdaAgain] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("oracle")],
    program.programId
  );

  for (const proposal of proposals) {
    if (!proposal.updateNeeded) continue;
    const mint = new anchor.web3.PublicKey(proposal.mint);
    const [gameTokenPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("game_token"), mint.toBuffer()],
      program.programId
    );

    const config = {
      minAmount: new anchor.BN(proposal.requiredMinAmount.toString()),
      enabled: true,
    };

    const instruction = await program.methods
      .updateToken(config)
      .accounts({
        gameToken: gameTokenPda,
        tokenMint: mint,
        oracle: oraclePdaAgain,
        oracleOperator: oracleOperatorBundle.anchor.publicKey,
      } as any)
      .instruction();

    const tx = await wallet.sendTransaction(
      [instruction],
      uniqueSigners(adminBundle.root, oracleOperatorBundle.root)
    );

    console.log(
      `   ✅ Updated ${proposal.ticker} minimum bet. Transaction: ${tx}`
    );
  }

  console.log("\n🎉 Minimum bet calibration complete.");
}

main().catch((error) => {
  console.error("❌ Failed to update minimum bets:", error);
  process.exit(1);
});
