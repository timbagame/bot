import { expect, test } from "bun:test";
import { createPumpPortalFeed, type SocketLike } from "../src/services/buy-alerts/feed";

class MockSocket implements SocketLike {
  sent: string[] = [];
  private listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
  closed = false;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.emit("close");
  }

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    const bucket = this.listeners.get(type) ?? [];
    bucket.push(listener);
    this.listeners.set(type, bucket);
  }

  emit(type: string, data?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data });
    }
  }
}

test("PumpPortal feed stays idle until a mint is watched", () => {
  const sockets: MockSocket[] = [];
  const feed = createPumpPortalFeed({
    socketFactory: () => {
      const socket = new MockSocket();
      sockets.push(socket);
      return socket;
    },
  });

  feed.setMints([]);
  feed.setMints(["", "  "]);
  expect(sockets).toHaveLength(0);
});

test("PumpPortal feed subscribes after open and emits parsed buys only", () => {
  const sockets: MockSocket[] = [];
  const feed = createPumpPortalFeed({
    socketFactory: () => {
      const socket = new MockSocket();
      sockets.push(socket);
      return socket;
    },
  });

  const received: string[] = [];
  feed.onTrade((event) => received.push(event.signature));

  feed.setMints(["mint-a"]);
  expect(sockets).toHaveLength(1);
  sockets[0]!.emit("open");
  expect(sockets[0]!.sent).toEqual([
    JSON.stringify({ method: "subscribeTokenTrade", keys: ["mint-a"] }),
  ]);

  sockets[0]!.emit(
    "message",
    JSON.stringify({
      signature: "buy-sig",
      mint: "mint-a",
      traderPublicKey: "Trader11111111111111111111111111111111111",
      txType: "buy",
      solAmount: 1,
      tokenAmount: 10,
      pool: "pump",
    }),
  );
  sockets[0]!.emit(
    "message",
    JSON.stringify({
      signature: "sell-sig",
      mint: "mint-a",
      traderPublicKey: "Trader11111111111111111111111111111111111",
      txType: "sell",
      solAmount: 1,
      tokenAmount: 10,
      pool: "pump",
    }),
  );

  expect(received).toEqual(["buy-sig"]);

  feed.setMints(["mint-b"]);
  expect(sockets[0]!.sent).toContain(
    JSON.stringify({ method: "unsubscribeTokenTrade", keys: ["mint-a"] }),
  );
  expect(sockets[0]!.sent).toContain(
    JSON.stringify({ method: "subscribeTokenTrade", keys: ["mint-b"] }),
  );

  feed.setMints([]);
  expect(sockets[0]!.closed).toBe(true);
});
