import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
    expect(addCalls).toEqual(["gameCompleted", "playerJoined", "playerUnjoined"]);
    const state = __test_getProgramEventListenerState();
    expect(state.gameCompletedListenerId).toBe(1);
    expect(state.playerJoinedListenerId).toBe(2);
    expect(state.playerUnjoinedListenerId).toBe(3);
    expect(state.programEventListenersReady).toBe(true);

    await __test_unregisterProgramEventListeners();
    expect(removeCalls).toEqual([1, 2, 3]);
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

    expect(addCalls).toEqual(["gameCompleted", "playerJoined"]);
    expect(removeCalls).toEqual([1]);
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
    expect(removeCalls).toEqual([1, 1, 1, 2, 3]);
    const state = __test_getProgramEventListenerState();
    expect(state.gameCompletedListenerId).toBe(1);
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
    expect(addCalls).toEqual(["gameCompleted", "playerJoined", "playerUnjoined"]);
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

    expect(removeCalls).toEqual([1, 1, 1, 2, 3]);
    expect(addCalls).toEqual([]);
    const afterFailedRestart = __test_getProgramEventListenerState();
    expect(afterFailedRestart.programEventListenersReady).toBe(false);
    expect(afterFailedRestart.gameCompletedListenerId).toBe(1);
    expect(afterFailedRestart.playerJoinedListenerId).toBeNull();
    expect(afterFailedRestart.playerUnjoinedListenerId).toBeNull();

    failCleanup = false;
    failoverCallback?.(change);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(removeCalls).toEqual([1, 1, 1, 2, 3, 1]);
    expect(addCalls).toEqual(["gameCompleted", "playerJoined", "playerUnjoined"]);
    const afterRecovery = __test_getProgramEventListenerState();
    expect(afterRecovery.gameCompletedListenerId).toBe(4);
    expect(afterRecovery.playerJoinedListenerId).toBe(5);
    expect(afterRecovery.playerUnjoinedListenerId).toBe(6);
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

    expect(removeCalls).toEqual([1, 2, 3]);
    expect(addCalls).toEqual([
      "gameCompleted",
      "playerJoined",
      "playerUnjoined",
      "gameCompleted",
      "playerJoined",
      "playerUnjoined",
    ]);

    const state = __test_getProgramEventListenerState();
    expect(state.gameCompletedListenerId).toBe(4);
    expect(state.playerJoinedListenerId).toBe(5);
    expect(state.playerUnjoinedListenerId).toBe(6);
    expect(state.programEventListenersReady).toBe(true);
  });
});
