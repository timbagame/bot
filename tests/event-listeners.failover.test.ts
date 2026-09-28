import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import BN from "bn.js";
import { Keypair } from "#solana";
import type { ActiveEndpointChange } from "../src/utils/rpc-endpoints";
import {
  wallet,
  __test_setProgram,
  __test_resetProgram,
  __test_registerProgramEventListeners,
  __test_unregisterProgramEventListeners,
  __test_attachRpcEndpointFailoverHandler,
  __test_getProgramEventListenerState,
  __test_resetProgramEventState,
  __test_setSleepImplementation,
  __test_resetSleepImplementation,
  __test_setProcessGameCompletionHandler,
  __test_resetProcessGameCompletionHandler,
  __test_setGameDatabase,
  __test_resetGameDatabase,
  __test_resetCompletionJobs,
} from "../src/bot";

describe("program event listener management", () => {
  let originalOnRpcEndpointChange: typeof wallet.onRpcEndpointChange;
  let addCalls: string[];
  let removeCalls: number[];
  let nextListenerId: number;

  beforeEach(() => {
    __test_setSleepImplementation(async () => {});
    addCalls = [];
    removeCalls = [];
    nextListenerId = 1;
    const fakeProgram = {
      addEventListener: async (eventName: string) => {
        addCalls.push(eventName);
        return nextListenerId++;
      },
      removeEventListener: async (id: number) => {
        removeCalls.push(id);
      },
    };
    __test_setProgram(fakeProgram as any);
    originalOnRpcEndpointChange = wallet.onRpcEndpointChange.bind(wallet);
  });

  afterEach(async () => {
    (wallet as any).onRpcEndpointChange = originalOnRpcEndpointChange;
    await __test_resetProgramEventState();
    __test_resetProgram();
  });

  test("registers and unregisters program listeners", async () => {
    await __test_registerProgramEventListeners();
    expect(addCalls).toEqual([
      "gameInitialized",
      "gameCompleted",
      "playerJoined",
      "playerUnjoined",
    ]);
    const state = __test_getProgramEventListenerState();
    expect(state.gameInitializedListenerId).toBe(1);
    expect(state.gameCompletedListenerId).toBe(2);
    expect(state.playerJoinedListenerId).toBe(3);
    expect(state.playerUnjoinedListenerId).toBe(4);
    expect(state.programEventListenersReady).toBe(true);

    await __test_unregisterProgramEventListeners();
    expect(removeCalls).toEqual([1, 2, 3, 4]);
    const after = __test_getProgramEventListenerState();
    expect(after.gameCompletedListenerId).toBeNull();
    expect(after.playerJoinedListenerId).toBeNull();
    expect(after.playerUnjoinedListenerId).toBeNull();
    expect(after.programEventListenersReady).toBe(false);
  });

  test("cleans up listeners when registration fails", async () => {
    addCalls = [];
    removeCalls = [];
    nextListenerId = 1;

    const failingProgram = {
      addEventListener: async (eventName: string) => {
        addCalls.push(eventName);
        if (eventName === "playerJoined") {
          throw new Error("boom");
        }
        return nextListenerId++;
      },
      removeEventListener: async (id: number) => {
        removeCalls.push(id);
      },
    };

    __test_setProgram(failingProgram as any);

    await expect(__test_registerProgramEventListeners()).rejects.toThrow("boom");

    expect(addCalls).toEqual(["gameInitialized", "gameCompleted", "playerJoined"]);
    expect(removeCalls).toEqual([1, 2]);
    const state = __test_getProgramEventListenerState();
    expect(state.programEventListenersReady).toBe(false);
  });

  test("retries removal and retains failed listener handles", async () => {
    await __test_registerProgramEventListeners();

    const removalFailures = new Set([1]);
    __test_setProgram({
      addEventListener: async (eventName: string) => {
        addCalls.push(eventName);
        return nextListenerId++;
      },
      removeEventListener: async (id: number) => {
        removeCalls.push(id);
        if (removalFailures.has(id)) {
          throw new Error("remove failed");
        }
      },
    } as any);

    const removed = await __test_unregisterProgramEventListeners();
    expect(removed).toBe(false);
    expect(removeCalls).toEqual([1, 1, 1, 2, 3, 4]);
    const state = __test_getProgramEventListenerState();
    expect(state.gameInitializedListenerId).toBe(1);
    expect(state.gameCompletedListenerId).toBeNull();
    expect(state.playerJoinedListenerId).toBeNull();
    expect(state.playerUnjoinedListenerId).toBeNull();
    expect(state.programEventListenersReady).toBe(false);
  });

  test("retries failover restart when cleanup previously failed", async () => {
    const callbacks: Array<(change: ActiveEndpointChange) => void> = [];
    let failCleanup = true;

    (wallet as any).onRpcEndpointChange = (listener: (change: ActiveEndpointChange) => void) => {
      callbacks.push(listener);
      return () => {
        const index = callbacks.indexOf(listener);
        if (index >= 0) {
          callbacks.splice(index, 1);
        }
      };
    };

    await __test_registerProgramEventListeners();
    expect(addCalls).toEqual([
      "gameInitialized",
      "gameCompleted",
      "playerJoined",
      "playerUnjoined",
    ]);
    addCalls = [];
    removeCalls = [];

    __test_setProgram({
      addEventListener: async (eventName: string) => {
        addCalls.push(eventName);
        return nextListenerId++;
      },
      removeEventListener: async (id: number) => {
        removeCalls.push(id);
        if (failCleanup && id === 1) {
          throw new Error("remove failed");
        }
      },
    } as any);

    __test_attachRpcEndpointFailoverHandler();

    const change: ActiveEndpointChange = {
      endpoint: "https://rpc-secondary",
      index: 1,
      previousEndpoint: "https://rpc-primary",
      previousIndex: 0,
    };
    const failoverCallback = callbacks[0];
    expect(failoverCallback).toBeDefined();
    failoverCallback?.(change);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(removeCalls).toEqual([1, 1, 1, 2, 3, 4]);
    expect(addCalls).toEqual([]);
    const afterFailedRestart = __test_getProgramEventListenerState();
    expect(afterFailedRestart.programEventListenersReady).toBe(false);
    expect(afterFailedRestart.gameInitializedListenerId).toBe(1);
    expect(afterFailedRestart.gameCompletedListenerId).toBeNull();
    expect(afterFailedRestart.playerJoinedListenerId).toBeNull();
    expect(afterFailedRestart.playerUnjoinedListenerId).toBeNull();

    failCleanup = false;
    failoverCallback?.(change);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(removeCalls).toEqual([1, 1, 1, 2, 3, 4, 1]);
    expect(addCalls).toEqual([
      "gameInitialized",
      "gameCompleted",
      "playerJoined",
      "playerUnjoined",
    ]);
    const afterRecovery = __test_getProgramEventListenerState();
    expect(afterRecovery.gameInitializedListenerId).toBe(5);
    expect(afterRecovery.gameCompletedListenerId).toBe(6);
    expect(afterRecovery.playerJoinedListenerId).toBe(7);
    expect(afterRecovery.playerUnjoinedListenerId).toBe(8);
    expect(afterRecovery.programEventListenersReady).toBe(true);
  });

  test("restarts listeners when RPC endpoint changes", async () => {
    const callbacks: Array<(change: ActiveEndpointChange) => void> = [];
    (wallet as any).onRpcEndpointChange = (listener: (change: ActiveEndpointChange) => void) => {
      callbacks.push(listener);
      return () => {
        const index = callbacks.indexOf(listener);
        if (index >= 0) {
          callbacks.splice(index, 1);
        }
      };
    };

    await __test_registerProgramEventListeners();
    __test_attachRpcEndpointFailoverHandler();
    expect(callbacks).toHaveLength(1);

    const change: ActiveEndpointChange = {
      endpoint: "https://rpc-secondary",
      index: 1,
      previousEndpoint: "https://rpc-primary",
      previousIndex: 0,
    };
    const failoverCallback = callbacks[0];
    expect(failoverCallback).toBeDefined();
    failoverCallback?.(change);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(removeCalls).toEqual([1, 2, 3, 4]);
    expect(addCalls).toEqual([
      "gameInitialized",
      "gameCompleted",
      "playerJoined",
      "playerUnjoined",
      "gameInitialized",
      "gameCompleted",
      "playerJoined",
      "playerUnjoined",
    ]);

    const state = __test_getProgramEventListenerState();
    expect(state.gameInitializedListenerId).toBe(5);
    expect(state.gameCompletedListenerId).toBe(6);
    expect(state.playerJoinedListenerId).toBe(7);
    expect(state.playerUnjoinedListenerId).toBe(8);
    expect(state.programEventListenersReady).toBe(true);
  });

  const captureRpcListener = () => {
    const callbacks: Array<(change: ActiveEndpointChange) => void> = [];
    (wallet as any).onRpcEndpointChange = (listener: (change: ActiveEndpointChange) => void) => {
      callbacks.push(listener);
      return () => undefined;
    };
    return callbacks;
  };
  const change: ActiveEndpointChange = {
    endpoint: "https://rpc-secondary",
    index: 1,
    previousEndpoint: "https://rpc-primary",
    previousIndex: 0,
  };

  test("without a program client there is nothing to register or remove", async () => {
    __test_setProgram(undefined);

    await __test_registerProgramEventListeners();
    expect(await __test_unregisterProgramEventListeners()).toBe(true);
    expect(addCalls).toEqual([]);
  });

  test("endpoint changes are ignored until listeners are registered", async () => {
    const callbacks = captureRpcListener();
    __test_attachRpcEndpointFailoverHandler();

    callbacks[0]!(change);
    await Bun.sleep(0);

    expect(addCalls).toEqual([]);
  });

  test("a failed restart after an endpoint change is logged", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const callbacks = captureRpcListener();
      await __test_registerProgramEventListeners();
      __test_attachRpcEndpointFailoverHandler();
      __test_setProgram({
        addEventListener: async () => {
          throw new Error("websocket closed");
        },
        removeEventListener: async () => undefined,
      } as any);

      callbacks[0]!(change);
      await Bun.sleep(0);

      expect(
        errorSpy.mock.calls.some((call: unknown[]) =>
          String(call[0]).startsWith(
            "❌ Failed to restart program event listeners after switching",
          ),
        ),
      ).toBe(true);
      expect(__test_getProgramEventListenerState().programEventListenersReady).toBe(false);
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  test("a wallet that cannot report endpoint changes only warns", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      (wallet as any).onRpcEndpointChange = () => {
        throw new Error("not supported");
      };

      __test_attachRpcEndpointFailoverHandler();

      expect(warnSpy).toHaveBeenCalledWith(
        "⚠️ Unable to attach RPC endpoint failover handler:",
        expect.any(Error),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("removal retries back off for real by default", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await __test_registerProgramEventListeners();
      __test_resetSleepImplementation();
      let failures = 1;
      __test_setProgram({
        addEventListener: async () => nextListenerId++,
        removeEventListener: async (id: number) => {
          removeCalls.push(id);
          if (id === 1 && failures-- > 0) throw new Error("remove failed");
        },
      } as any);

      const started = Date.now();
      expect(await __test_unregisterProgramEventListeners()).toBe(true);

      expect(Date.now() - started).toBeGreaterThanOrEqual(190);
      expect(removeCalls).toEqual([1, 1, 2, 3, 4]);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("GameCompleted program events", () => {
  let handlers: Record<string, (...args: any[]) => Promise<void>>;
  let processed: ReturnType<typeof mock>;
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    handlers = {};
    __test_setSleepImplementation(async () => {});
    __test_setProgram({
      addEventListener: async (name: string, handler: any) => {
        handlers[name] = handler;
        return Object.keys(handlers).length;
      },
      removeEventListener: async () => undefined,
    } as any);
    // No finance recording, so completion never reaches the RPC for fees.
    __test_setGameDatabase({} as any);
    processed = mock(async () => undefined);
    __test_setProcessGameCompletionHandler(processed as any);
    logSpy = spyOn(console, "log").mockImplementation(() => {});
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
    await __test_registerProgramEventListeners();
  });

  afterEach(async () => {
    await __test_resetProgramEventState();
    __test_resetProgram();
    __test_resetProcessGameCompletionHandler();
    __test_resetGameDatabase();
    __test_resetCompletionJobs();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  const completed = async () => ({
    gameKey: (await Keypair.generate()).publicKey,
    winner: (await Keypair.generate()).publicKey,
    winnerAmount: new BN(9_500),
    feeAmount: new BN(500),
  });

  const logged = (text: string) =>
    logSpy.mock.calls.some((call: unknown[]) => String(call[0]).includes(text));

  test("processes the completion with the full pot and winner payout", async () => {
    const event = await completed();

    await handlers["gameCompleted"]!(event, 77, "completion-sig");

    expect(processed).toHaveBeenCalledWith(
      event.gameKey.toString(),
      event.winner.toString(),
      10_000,
      "completion-sig",
      9_500,
    );
    expect(logged("🔗 Completion signature: completion-sig")).toBe(true);
    expect(logged("✅ Successfully processed GameCompleted event")).toBe(true);
  });

  test("a duplicate event while the first is processing is skipped", async () => {
    let release!: () => void;
    processed.mockImplementation(() => new Promise<void>((resolve) => (release = resolve)));
    const event = await completed();

    const first = handlers["gameCompleted"]!(event, 1);
    await Bun.sleep(0);
    await handlers["gameCompleted"]!(event, 1);
    release();
    await first;

    expect(processed).toHaveBeenCalledTimes(1);
    expect(logged("Skipping duplicate completion processing")).toBe(true);
    expect(logged("🔗 Completion signature")).toBe(false);
  });

  test("processing failures are logged", async () => {
    processed.mockImplementation(async () => {
      throw new Error("db locked");
    });

    await handlers["gameCompleted"]!(await completed(), 1);

    expect(errorSpy).toHaveBeenCalledWith(
      "Error processing GameCompleted event:",
      expect.any(Error),
    );
  });
});
