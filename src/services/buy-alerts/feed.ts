import { parsePumpPortalTrade } from "./parser";
import type { BuyEvent, BuyFeed } from "./types";

export const PUMPPORTAL_WS_URL = "wss://pumpportal.fun/api/data";

export function buildPumpPortalWsUrl(apiKey: string | undefined): string {
  const normalizedApiKey = apiKey?.trim();
  if (!normalizedApiKey) {
    throw new Error(
      "PUMPPORTAL_API_KEY is required when buy alerts are enabled. Create and fund a PumpPortal data API key before starting the feed.",
    );
  }

  const url = new URL(PUMPPORTAL_WS_URL);
  url.searchParams.set("api-key", normalizedApiKey);
  return url.toString();
}

export type SocketLike = {
  send: (data: string) => void;
  close: () => void;
  addEventListener: (type: string, listener: (event: { data?: unknown }) => void) => void;
};

export type PumpPortalFeedOptions = {
  url?: string;
  apiKey?: string;
  socketFactory?: (url: string) => SocketLike;
  reconnectDelayMs?: number;
};

const defaultSocketFactory = (url: string): SocketLike =>
  new WebSocket(url) as unknown as SocketLike;

export function createPumpPortalFeed(options: PumpPortalFeedOptions = {}): BuyFeed {
  const socketFactory = options.socketFactory ?? defaultSocketFactory;
  const reconnectDelayMs = options.reconnectDelayMs ?? 1_000;

  let socket: SocketLike | null = null;
  let open = false;
  let stopped = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let mints = new Set<string>();
  const handlers = new Set<(event: BuyEvent) => void>();

  const send = (payload: unknown) => {
    if (!socket || !open) return;
    socket.send(JSON.stringify(payload));
  };

  const subscribeCurrent = () => {
    if (mints.size === 0) return;
    send({ method: "subscribeTokenTrade", keys: Array.from(mints) });
  };

  const connect = () => {
    if (stopped || mints.size === 0 || socket) {
      return;
    }

    const url =
      options.url ?? buildPumpPortalWsUrl(options.apiKey ?? process.env.PUMPPORTAL_API_KEY);
    const nextSocket = socketFactory(url);
    socket = nextSocket;
    open = false;

    nextSocket.addEventListener("open", () => {
      if (socket !== nextSocket) return;
      open = true;
      subscribeCurrent();
    });

    nextSocket.addEventListener("message", (event) => {
      if (socket !== nextSocket) return;
      const raw = event.data;
      if (typeof raw !== "string") return;
      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        return;
      }
      const buy = parsePumpPortalTrade(payload);
      if (!buy) return;
      for (const handler of handlers) {
        handler(buy);
      }
    });

    nextSocket.addEventListener("close", () => {
      if (socket !== nextSocket) return;
      open = false;
      socket = null;
      if (stopped || mints.size === 0) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, reconnectDelayMs);
      if (reconnectTimer && typeof (reconnectTimer as NodeJS.Timeout).unref === "function") {
        (reconnectTimer as NodeJS.Timeout).unref();
      }
    });
  };

  const disconnect = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (socket) {
      const current = socket;
      socket = null;
      open = false;
      try {
        current.close();
      } catch {
        // ignore
      }
    }
  };

  return {
    setMints: (nextMints) => {
      const normalized = new Set(
        nextMints.map((mint) => mint.trim()).filter((mint) => mint.length > 0),
      );
      const previous = mints;
      mints = normalized;

      if (normalized.size === 0) {
        disconnect();
        return;
      }

      if (!socket) {
        connect();
        return;
      }

      const removed = Array.from(previous).filter((mint) => !normalized.has(mint));
      const added = Array.from(normalized).filter((mint) => !previous.has(mint));
      if (removed.length > 0) {
        send({ method: "unsubscribeTokenTrade", keys: removed });
      }
      if (added.length > 0) {
        send({ method: "subscribeTokenTrade", keys: added });
      }
    },
    onTrade: (handler) => {
      handlers.add(handler);
    },
    stop: () => {
      stopped = true;
      mints = new Set();
      disconnect();
    },
  };
}
