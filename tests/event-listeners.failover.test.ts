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
} from "../src/bot";

describe("program event listener management", () => {
  let originalOnRpcEndpointChange: typeof wallet.onRpcEndpointChange;
let addCalls: string[];
let removeCalls: number[];
let nextListenerId: number;

  beforeEach(() => {
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
      "gameCompleted",
      "playerJoined",
      "playerUnjoined",
    ]);
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

  test("restarts listeners when RPC endpoint changes", async () => {
    const callbacks: Array<(change: ActiveEndpointChange) => void> = [];
    (wallet as any).onRpcEndpointChange = (
      listener: (change: ActiveEndpointChange) => void,
    ) => {
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
