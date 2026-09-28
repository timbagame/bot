import { describe, test, expect, spyOn } from "bun:test";
import { Keypair, PublicKey } from "#solana";
import { GameManager } from "../src/utils/game";
import { GAME_EXPIRATION_BUFFER_TIME } from "../src/utils/constants";

function resetGM() {
  // @ts-ignore
  GameManager["instance"] = undefined;
}

function programStub() {
  return { account: { game: { fetch: async () => ({}) } } } as any;
}
function walletStub() {
  return {} as any;
}
function dbStub() {
  return { getGameParticipants: () => [] } as any;
}

describe("GameManager private helpers", () => {
  test("isGameExpiredWithBuffer respects timeout and buffer", () => {
    resetGM();
    const gm = GameManager.getInstance(programStub(), walletStub(), dbStub());
    const now = Math.floor(Date.now() / 1000);
    const expired = (gm as any).isGameExpiredWithBuffer({
      createdAt: now - (60 + GAME_EXPIRATION_BUFFER_TIME + 1),
      timeout: 60,
    });
    const notExpired = (gm as any).isGameExpiredWithBuffer({ createdAt: now - 50, timeout: 60 });
    expect(expired).toBe(true);
    expect(notExpired).toBe(false);
  });

  test("getGameType returns first key or unknown", () => {
    resetGM();
    const gm = GameManager.getInstance(programStub(), walletStub(), dbStub());
    expect((gm as any).getGameType({ gameType: { coinflip: {} } })).toBe("coinflip");
    expect((gm as any).getGameType({ gameType: {} })).toBe("unknown");
  });

  test("handleGameProcessingError maps account missing to true, others to false", () => {
    resetGM();
    const gm = GameManager.getInstance(programStub(), walletStub(), dbStub());
    expect((gm as any).handleGameProcessingError(new Error("Account does not exist"), "addr")).toBe(
      true,
    );
    expect((gm as any).handleGameProcessingError(new Error("boom"), "addr")).toBe(false);
  });
});

describe("GameManager message and creation helpers", () => {
  const GAME = "BPFLoader1111111111111111111111111111111111";

  test("setGameMessageReadyListener stores and clears the listener", () => {
    resetGM();
    const gm = GameManager.getInstance(programStub(), walletStub(), dbStub());
    const listener = () => {};
    gm.setGameMessageReadyListener(listener);
    expect((gm as any).gameMessageReadyListener).toBe(listener);
    gm.setGameMessageReadyListener(undefined);
    expect((gm as any).gameMessageReadyListener).toBeUndefined();
  });

  test("a failed message update rejects, releases its queue slot and does not block the next", async () => {
    resetGM();
    const gm = GameManager.getInstance(programStub(), walletStub(), dbStub());
    const failure = new Error("telegram down");
    const order: string[] = [];

    const failed = (gm as any).enqueueGameMessageUpdate(GAME, async () => {
      order.push("first");
      throw failure;
    });
    const next = (gm as any).enqueueGameMessageUpdate(GAME, async () => {
      order.push("second");
    });

    await expect(failed).rejects.toBe(failure);
    await next;
    await Promise.resolve();
    expect(order).toEqual(["first", "second"]);
    expect((gm as any).gameMessageUpdateQueues.has(GAME)).toBe(false);

    const lone = (gm as any).enqueueGameMessageUpdate("lone-game", async () => {
      throw failure;
    });
    await expect(lone).rejects.toBe(failure);
    await Promise.resolve();
    expect((gm as any).gameMessageUpdateQueues.has("lone-game")).toBe(false);
  });

  test("buildUnjoinAccounts reuses join accounts and adds the signing authority", async () => {
    resetGM();
    const gm = GameManager.getInstance(programStub(), walletStub(), dbStub());
    const gamePda = new PublicKey(GAME);
    const player = (await Keypair.generate()).publicKey;
    const authority = (await Keypair.generate()).publicKey;
    const joinCalls: any[][] = [];
    (gm as any).buildJoinAccounts = async (...args: any[]) => {
      joinCalls.push(args);
      return { accounts: { game: gamePda, player }, setupInstructions: [{ ix: 1 }] };
    };

    const accounts = await (gm as any).buildUnjoinAccounts(gamePda, { any: 1 }, player, authority);

    expect(joinCalls).toEqual([[gamePda, { any: 1 }, player]]);
    expect(accounts).toEqual({ game: gamePda, player, authority });
  });

  test("formatUsdValue formats positive safe amounts and rejects invalid inputs", () => {
    resetGM();
    const gm = GameManager.getInstance(programStub(), walletStub(), dbStub());
    const format = (amount: any, decimals: number, price: number) =>
      (gm as any).formatUsdValue(amount, decimals, price);

    expect(format(2_500_000n, 6, 4)).toBe("$10");
    expect(format("1500000000", 9, 100)).toBe("$150");
    expect(format(0, 6, 4)).toBeNull();
    expect(format("not-a-number", 6, 4)).toBeNull();
    expect(format(1_000_000, 6, 0)).toBeNull();
    expect(format(1_000_000, 6, Number.NaN)).toBeNull();
    expect(format(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 6, 1)).toBeNull();
    expect(format(1, 400, 1)).toBeNull();
  });

  test("getPrizeDisplay formats the pot with stored token details", async () => {
    resetGM();
    const db = { ...dbStub(), getGame: () => ({ token_ticker: "TIMBA", token_mint: "mint" }) };
    const gm = GameManager.getInstance(programStub(), walletStub(), db as any);
    const resolveCalls: any[][] = [];
    (gm as any).resolveTokenFormattingInfo = async (...args: any[]) => {
      resolveCalls.push(args);
      return {
        formatBalance: (value: number) => (value / 100).toString(),
        decimals: 2,
        tokenMint: "mint",
        isSol: false,
      };
    };

    expect(await gm.getPrizeDisplay(GAME, 1250)).toEqual({
      formattedAmount: "12.5",
      tokenTicker: "TIMBA",
      usdApproximation: null,
    });
    expect(resolveCalls[0]?.[1]).toBe("TIMBA");
    expect(resolveCalls[0]?.[2]).toBe("mint");
    expect(await gm.getPrizeDisplay(GAME, 0)).toBeNull();
    expect(await gm.getPrizeDisplay(GAME, Number.NaN)).toBeNull();
  });

  test("getPrizeDisplay returns null and logs when the game address is invalid", async () => {
    resetGM();
    const gm = GameManager.getInstance(programStub(), walletStub(), dbStub());
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await gm.getPrizeDisplay("not-a-key", 10)).toBeNull();
      expect(warnSpy.mock.calls[0]?.[0]).toBe("Failed to compute prize display for not-a-key:");
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("ownsPendingCreationMessage matches the pending creation placeholder exactly", () => {
    resetGM();
    const db = {
      ...dbStub(),
      getPendingGameCreation: (address: string) =>
        address === GAME ? { chat_id: -100, creation_message_id: 55 } : null,
    };
    const gm = GameManager.getInstance(programStub(), walletStub(), db as any);

    expect(gm.ownsPendingCreationMessage(GAME, -100, 55)).toBe(true);
    expect(gm.ownsPendingCreationMessage(GAME, -100, 56)).toBe(false);
    expect(gm.ownsPendingCreationMessage(GAME, -101, 55)).toBe(false);
    expect(gm.ownsPendingCreationMessage("other", -100, 55)).toBe(false);
  });

  test("clearPendingGameCreation delegates to the game database", () => {
    resetGM();
    const cleared: string[] = [];
    const db = {
      ...dbStub(),
      clearPendingGameCreation: (address: string) => cleared.push(address),
    };
    const gm = GameManager.getInstance(programStub(), walletStub(), db as any);

    gm.clearPendingGameCreation(GAME);
    expect(cleared).toEqual([GAME]);
  });

  test("rebroadcasts a creation only while it is the current unexpired submission", async () => {
    resetGM();
    let pending: any = { game_address: GAME, transaction_signature: "sig-1" };
    const db = { ...dbStub(), getPendingGameCreation: () => pending };
    const gm = GameManager.getInstance(programStub(), walletStub(), db as any);
    let expired = false;
    const rebroadcasts: any[][] = [];
    (gm as any).isPendingGameCreationLifetimeExpired = async () => expired;
    (gm as any).rebroadcastPendingGameCreation = async (...args: any[]) => {
      rebroadcasts.push(args);
    };
    const rebroadcast = (signature: string, signal = new AbortController().signal) =>
      (gm as any).rebroadcastCurrentGameCreation(GAME, signature, signal);

    await rebroadcast("sig-1");
    expect(rebroadcasts).toHaveLength(1);
    expect(rebroadcasts[0]?.[0]).toBe(pending);

    await rebroadcast("sig-old");
    expired = true;
    await rebroadcast("sig-1");
    pending = null;
    await rebroadcast("sig-1");
    expect(rebroadcasts).toHaveLength(1);

    pending = { game_address: GAME, transaction_signature: "sig-1" };
    expired = false;
    const controller = new AbortController();
    controller.abort(new Error("confirmation finished"));
    await expect(rebroadcast("sig-1", controller.signal)).rejects.toThrow("confirmation finished");
    expect(rebroadcasts).toHaveLength(1);
  });

  test("chat-bound contexts route replies to the origin chat", async () => {
    resetGM();
    const gm = GameManager.getInstance(programStub(), walletStub(), dbStub());
    const calls: any[][] = [];
    const api = new Proxy(
      {},
      {
        get:
          (_target, method) =>
          async (...args: any[]) => {
            calls.push([method, ...args]);
            return { ok: true };
          },
      },
    );
    const ctx: any = { api, chat: { id: 1 }, from: { id: 9 } };

    expect((gm as any).createChatBoundContext(ctx, 1)).toBe(ctx);
    const bound = (gm as any).createChatBoundContext(ctx, 2);
    expect(bound.chat).toEqual({ id: 2 });
    expect(bound.from).toEqual({ id: 9 });
    await bound.reply("hi", { a: 1 });
    await bound.replyWithPhoto("photo-id");
    await bound.replyWithAnimation("anim-id", { caption: "c" });
    await bound.replyWithVideo("video-id");
    expect(calls).toEqual([
      ["sendMessage", 2, "hi", { a: 1 }],
      ["sendPhoto", 2, "photo-id", undefined],
      ["sendAnimation", 2, "anim-id", { caption: "c" }],
      ["sendVideo", 2, "video-id", undefined],
    ]);
  });

  test("recovered creations with an existing origin card only remove the placeholder", async () => {
    resetGM();
    const db = {
      ...dbStub(),
      getGameMessages: () => [
        { chat_id: -7, message_id: 0 },
        { chatId: -7, messageId: 31 },
      ],
    };
    const gm = GameManager.getInstance(programStub(), walletStub(), db as any);
    let created = 0;
    (gm as any).createGameMessage = async () => {
      created += 1;
      return 1;
    };
    const deleted: any[][] = [];
    const ctx: any = {
      chat: { id: -7 },
      api: { deleteMessage: async (...args: any[]) => deleted.push(args) },
    };

    await (gm as any).deliverPendingGameCreation(
      ctx,
      { game_address: GAME, chat_id: -7, creation_message_id: 12 },
      { status: "active" },
    );

    expect(created).toBe(0);
    expect(deleted).toEqual([[-7, 12]]);
  });
});

describe("GameManager chain state helpers", () => {
  test("active game stats keep only valid participant keys", async () => {
    resetGM();
    const saved: any[][] = [];
    const db = {
      ...dbStub(),
      saveGameParticipantAddresses: (...args: any[]) => saved.push(args),
    };
    const wallet = { getBlockchainTime: async () => 1_000 };
    const gm = GameManager.getInstance(programStub(), wallet as any, db as any);
    const first = (await Keypair.generate()).publicKey;
    const second = (await Keypair.generate()).publicKey;
    const gamePda = new PublicKey("BPFLoader1111111111111111111111111111111111");

    const stats = await (gm as any).getActiveGameStats(gamePda, 10n, undefined, {
      ticketsCount: 2,
      maxTickets: 3,
      minTickets: 2,
      totalAmount: 20n,
      createdAt: 900,
      timeout: 600,
      gameType: { coinflip: {} },
      participants: [first, "not-a-key", second.toBase58()],
    });

    expect(stats.participantAddresses).toEqual([first.toBase58(), second.toBase58()]);
    expect(stats.totalPot).toBe(20n);
    expect(saved).toEqual([[gamePda.toBase58(), [first.toBase58(), second.toBase58()]]]);
  });

  test("active game lists omit closed accounts and games whose lookup fails", async () => {
    resetGM();
    const missing = "BPFLoader1111111111111111111111111111111111";
    const failing = "BPFLoader2111111111111111111111111111111111";
    const failure = new Error("rpc unavailable");
    const program = {
      account: {
        game: {
          fetch: async (pda: PublicKey) => {
            if (pda.toBase58() === missing) throw new Error(`Account ${missing} does not exist`);
            throw failure;
          },
        },
      },
    } as any;
    const gm = GameManager.getInstance(program, walletStub(), dbStub());
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const rows = await (gm as any).formatActiveGamesList({} as any, [
        { game_address: missing, game_type: "coinflip" },
        { game_address: failing, game_type: "coinflip" },
      ]);

      expect(rows).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(
        `Omitting stale active game ${missing}; account is absent`,
      );
      expect(warnSpy).toHaveBeenCalledWith(`Failed to format active game ${failing}:`, failure);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
