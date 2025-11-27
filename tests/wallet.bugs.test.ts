import { expect, test, vi, describe, beforeEach } from "bun:test";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { WalletManager } from "../src/utils/wallet";

// Mock dependencies
const mockFetch = vi.fn();
const mockTimeNow = vi.fn(() => Date.now());

describe("WalletManager Bugs & Edge Cases", () => {
  let wm: WalletManager;
  let connection: any;

  beforeEach(() => {
    vi.clearAllMocks();
    connection = {
      getSlot: vi.fn().mockResolvedValue(100),
      getBlockTime: vi.fn().mockResolvedValue(Math.floor(Date.now() / 1000)),
      getLatestBlockhash: vi.fn().mockResolvedValue({
        blockhash: Keypair.generate().publicKey.toBase58(), // Use valid base58 string
        lastValidBlockHeight: 1000,
      }),
      getBalance: vi.fn().mockResolvedValue(10 * LAMPORTS_PER_SOL),
      getAccountInfo: vi.fn().mockResolvedValue(null),
      sendTransaction: vi.fn().mockResolvedValue("SIG123"),
      confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null } }),
      getSignatureStatus: vi.fn().mockResolvedValue({
        value: { confirmationStatus: "confirmed", err: null },
      }),
      getSignatureStatuses: vi.fn().mockResolvedValue({
        value: [{ confirmationStatus: "confirmed", err: null }]
      }),
      getFeeForMessage: vi.fn().mockResolvedValue(5000),
    };

    wm = WalletManager.createForTest(
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
      {
        connection: connection as any,
        fetch: mockFetch as any,
        timeNow: mockTimeNow,
      }
    );
  });

  // WalletManager.wrapSol - Wraps more SOL than available
  test("wrapSol rejects amounts greater than available balance", async () => {
    const hugeAmount = 1000 * LAMPORTS_PER_SOL; // More than the 10 SOL mock balance
    // Current behavior: It proceeds to send transaction and fails on chain
    // Desired behavior: It should check balance first and throw
    await expect(wm.wrapSol(1n, hugeAmount)).rejects.toThrow(/insufficient/i);
  });

  // WalletManager.transferToken - Unsafe float amounts
  test("transferToken rejects unsafe float amounts", async () => {
    const unsafeAmount = 1.5;
    const toAddress = Keypair.generate().publicKey;
    const tokenMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

    // Mock token metadata to avoid network calls
    (wm as any).getTokenMetadata = vi.fn().mockResolvedValue({ decimals: 6 });
    (wm as any).findOrCreateAssociatedTokenAccount = vi.fn().mockResolvedValue({
        address: Keypair.generate().publicKey,
        instructions: []
    });

    // Current behavior: It might crash or truncate depending on implementation
    // Desired behavior: Should reject non-integer amounts
    await expect(
      wm.transferToken(1n, toAddress, unsafeAmount, tokenMint)
    ).rejects.toThrow(/integer/i);
  });

  // WalletManager.probeTransaction - Non-retryable RPC errors
  test("probeTransaction handles non-retryable RPC errors gracefully", async () => {
    // We need to trigger the timeout flow to reach probeTransaction
    (wm as any).confirmationTimeoutMs = 10; // Short timeout
    (wm as any).postTimeoutProbeBackoffMs = 0;
    (wm as any).signaturePollIntervalMs = 1;

    // Mock getSignatureStatus to return null (timeout)
    connection.getSignatureStatus = vi.fn().mockResolvedValue({ value: null });
    connection.getSignatureStatuses = vi.fn().mockResolvedValue({ value: [null] });

    // Mock connection.getTransaction to throw a 503 error
    connection.getTransaction = vi.fn().mockRejectedValue(new Error("503 Service Unavailable"));

    try {
        await wm.sendAndConfirmWithResubmits(
            [SystemProgram.transfer({ fromPubkey: Keypair.generate().publicKey, toPubkey: Keypair.generate().publicKey, lamports: 100 })],
            [Keypair.generate()],
            { maxResubmits: 0 }
        );
    } catch (e: any) {
        // We expect a timeout error
    }

    // If B-003 exists (abort early on 503), it might have only called once or zero times if logic is flawed
    // We expect it to retry 3 times (default postTimeoutProbeMaxAttempts)
    // If it fails with 1 call, it confirms the bug (abort early)
    expect(connection.getTransaction).toHaveBeenCalledTimes((wm as any).postTimeoutProbeMaxAttempts);
  });

  // WalletManager.unwrapSol - NaN/Infinity
  test("unwrapSol rejects NaN or Infinity for adminTopUpLamports", async () => {
    const payer = Keypair.generate();
    const adminKeypair = Keypair.generate();

    // Mock internal calls
    (wm as any).buildUnwrapWsolPlan = vi.fn().mockResolvedValue({
        instructions: [],
        unwrapLamports: 1000,
        remainingLamports: 0
    });
    (wm as any).sendAndConfirmWithResubmits = vi.fn().mockResolvedValue("SIG");

    // NaN
    await expect(
        wm.unwrapSolWithKeypair({
            owner: payer.publicKey,
            payer,
            adminKeypair,
            adminTopUpLamports: NaN,
            amountLamports: 1000
        })
    ).rejects.toThrow();

    // Infinity
    await expect(
        wm.unwrapSolWithKeypair({
            owner: payer.publicKey,
            payer,
            adminKeypair,
            adminTopUpLamports: Infinity,
            amountLamports: 1000
        })
    ).rejects.toThrow();
  });

  // WalletManager.transferToken - Concurrent transfers
  test("Concurrent transferToken calls to new destination should not fail", async () => {
    const toAddress = Keypair.generate().publicKey;
    const tokenMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

    // Mock metadata
    (wm as any).getTokenMetadata = vi.fn().mockResolvedValue({ decimals: 6 });

    let accountExists = false;
    (wm as any).connection.getAccountInfo = vi.fn().mockImplementation(async () => {
        if (accountExists) return { data: Buffer.alloc(0), owner: PublicKey.default };
        return null;
    });

    const sendSpy = vi.spyOn(wm as any, "sendTransaction");

    const p1 = wm.transferToken(1n, toAddress, 100, tokenMint);
    const p2 = wm.transferToken(1n, toAddress, 200, tokenMint);

    await Promise.all([p1, p2]);

    // Check if both transactions tried to create the ATA
    // If both have > 1 instruction (transfer + create), then we have a race condition bug
    // (Because on chain, the second one would fail)
    const calls = sendSpy.mock.calls;
    expect(calls.length).toBe(2);

    const instructions1 = calls[0]?.[0] as TransactionInstruction[] | undefined;
    const instructions2 = calls[1]?.[0] as TransactionInstruction[] | undefined;

    if (!instructions1 || !instructions2) {
        throw new Error("Expected 2 calls to sendTransaction");
    }

    // Assuming standard transfer is 1 instruction if ATA exists, >1 if it needs creation
    // Actually transferToken adds instructions from findOrCreateAssociatedTokenAccount
    // If ATA missing: create + transfer = 2 instructions
    // If ATA exists: transfer = 1 instruction

    // If bug exists, both have 2 instructions
    expect(instructions1.length).toBeGreaterThan(1);
    expect(instructions2.length).toBeGreaterThan(1);

    // If fixed, one should have 2, the other should have 1 (or wait)
  });

  // WalletManager.resubmit - Double spend risk
  test("resubmit logic avoids double spend if first tx confirms late", async () => {
    // Setup:
    // 1. sendTransaction returns SIG1
    // 2. confirmTransaction(SIG1) times out
    // 3. resubmit triggers -> sendTransaction returns SIG2

    const sentSigs: string[] = [];
    (wm as any).sendTransaction = vi.fn().mockImplementation(async () => {
        const sig = `SIG-${sentSigs.length}`;
        sentSigs.push(sig);
        return sig;
    });

    // Mock confirmTransaction to timeout for SIG-0
    (wm as any).confirmTransaction = vi.fn().mockImplementation(async (sig) => {
        if (sig === "SIG-0") {
            throw new Error("Transaction confirmation timeout");
        }
        return;
    });

    // We expect the code to check status of SIG-0 before resubmitting
    const statusSpy = vi.spyOn(connection, "getSignatureStatuses");

    await wm.sendAndConfirmWithResubmits(
        [SystemProgram.transfer({ fromPubkey: Keypair.generate().publicKey, toPubkey: Keypair.generate().publicKey, lamports: 100 })],
        [Keypair.generate()],
        { maxResubmits: 1 }
    );

    // If bug exists, it resubmits without checking status
    // So getSignatureStatuses should NOT be called for SIG-0 (except maybe inside confirmTransaction, but we mocked it out)
    // Wait, if we mocked confirmTransaction, then getSignatureStatuses is NOT called by confirmTransaction.
    // So if sendAndConfirmWithResubmits checks it, it should be called.

    expect(statusSpy).toHaveBeenCalledWith(["SIG-0"]);
  });

  // WalletManager.withdrawAllSol - Race condition
  test("withdrawAllSol handles balance decrease between fetch and send", async () => {
    // 1. getBalance returns 10 SOL
    // 2. estimateFee returns 0.005 SOL
    // 3. sendTransaction fails because actual balance dropped to 9 SOL (concurrent transfer out)

    connection.getBalance = vi.fn()
        .mockResolvedValueOnce(10 * LAMPORTS_PER_SOL) // Initial check
        .mockResolvedValueOnce(9 * LAMPORTS_PER_SOL); // Second check (if it retries)

    (wm as any).sendTransaction = vi.fn()
        .mockRejectedValueOnce(new Error("insufficient funds")) // First try fails
        .mockResolvedValue("SIG-RETRY"); // Second try succeeds

    // Current behavior: It throws "insufficient funds" and gives up
    // Desired behavior: It catches, refreshes balance, and retries with new amount

    const res = await wm.withdrawAllSol(1n, Keypair.generate().publicKey);

    expect(res.signature).toBe("SIG-RETRY");
    expect(res.totalLamportsSent).toBeLessThan(10 * LAMPORTS_PER_SOL);
  });

});
