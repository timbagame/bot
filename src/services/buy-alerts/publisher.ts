import { LAMPORTS_PER_SOL, CHAT_MEDIA_DISABLED_SENTINEL } from "../../utils/constants";
import { createExpiringCache } from "../../utils/expiring-cache";
import type { ChatBuyAlertConfig } from "../../types";
import type { ChatDatabase } from "../../utils/chat-database";
import { fetchDexScreenerPairStats } from "./dexscreener";
import { formatBuyAlertMessage } from "./formatter";
import { resolveBuyAlertToken } from "./resolve";
import type { BuyEvent, BuyFeed, PairStats } from "./types";

export const BUY_ALERTS_PER_MINUTE = 10;
const SIGNATURE_TTL_MS = 60 * 60 * 1000;

export type BuyAlertMedia = {
  fileId: string;
  mediaType: "photo" | "video" | "animation";
};

export type BuyAlertTokenSource = {
  getChatDefaultToken: (chatId: number) => {
    token_mint: string;
    token_ticker: string;
  } | null;
  getDefaultToken: () => { tokenMint: string; tokenTicker: string };
};

export type BuyAlertPublisherDeps = {
  chatDb: ChatDatabase;
  tokenManager: BuyAlertTokenSource;
  sendHtml: (chatId: number, text: string, media?: BuyAlertMedia | null) => Promise<void>;
  fetchPairStats?: (mint: string) => Promise<PairStats | null>;
  fetchSolPriceUsd?: () => Promise<number | null>;
  resolveNewHolder?: (event: BuyEvent) => Promise<boolean | null>;
  now?: () => number;
  maxAlertsPerMinute?: number;
};

export type PublishResult = {
  posted: number;
  skipped: string[];
};

export function createBuyAlertPublisher(deps: BuyAlertPublisherDeps) {
  const fetchPairStats = deps.fetchPairStats ?? fetchDexScreenerPairStats;
  const now = deps.now ?? Date.now;
  const maxAlertsPerMinute = deps.maxAlertsPerMinute ?? BUY_ALERTS_PER_MINUTE;
  const postedSignatures = createExpiringCache<true>(SIGNATURE_TTL_MS);
  const chatWindows = new Map<number, number[]>();

  const resolveForChat = (chatId: number) => {
    const config = deps.chatDb.getChatBuyAlerts(chatId);
    return resolveBuyAlertToken(
      config,
      deps.tokenManager.getChatDefaultToken(chatId),
      deps.tokenManager.getDefaultToken(),
    );
  };

  const allowChat = (chatId: number): boolean => {
    const current = now();
    const windowStart = current - 60_000;
    const stamps = (chatWindows.get(chatId) ?? []).filter((stamp) => stamp > windowStart);
    if (stamps.length >= maxAlertsPerMinute) {
      chatWindows.set(chatId, stamps);
      return false;
    }
    stamps.push(current);
    chatWindows.set(chatId, stamps);
    return true;
  };

  const matchesMint = (chatId: number, mint: string, enabledOnly = true): boolean => {
    const config = deps.chatDb.getChatBuyAlerts(chatId);
    if (enabledOnly && !config?.enabled) {
      return false;
    }
    return resolveForChat(chatId).mint === mint;
  };

  const belowMinimum = (chatId: number, solAmount: number | null): boolean => {
    const minLamports = deps.chatDb.getChatBuyAlerts(chatId)?.min_sol_lamports;
    if (minLamports == null || minLamports <= 0) {
      return false;
    }
    if (solAmount == null || solAmount <= 0) {
      return true;
    }
    return solAmount * LAMPORTS_PER_SOL + 1e-9 < minLamports;
  };

  const enrichEvent = async (event: BuyEvent): Promise<BuyEvent> => {
    if (event.newHolder != null) {
      return event;
    }
    if (!deps.resolveNewHolder) {
      return event;
    }
    const newHolder = await deps.resolveNewHolder(event);
    return newHolder == null ? event : { ...event, newHolder };
  };

  const resolveMedia = (chatId: number): BuyAlertMedia | null => {
    return resolveBuyAlertMedia(deps.chatDb.getChatBuyAlerts(chatId));
  };

  const publishToChat = async (
    chatId: number,
    event: BuyEvent,
    pair: PairStats | null,
    solPriceUsd: number | null,
  ): Promise<boolean> => {
    const token = resolveForChat(chatId);
    const text = formatBuyAlertMessage({
      event,
      ticker: token.ticker,
      pair,
      solPriceUsd,
    });
    try {
      await deps.sendHtml(chatId, text, resolveMedia(chatId));
      return true;
    } catch (error) {
      console.error(`Failed to send buy alert to chat ${chatId}:`, error);
      return false;
    }
  };

  return {
    watchedMints: (): string[] => {
      const mints = new Set<string>();
      for (const config of deps.chatDb.getEnabledChatBuyAlerts()) {
        mints.add(
          resolveBuyAlertToken(
            config,
            deps.tokenManager.getChatDefaultToken(config.chat_id),
            deps.tokenManager.getDefaultToken(),
          ).mint,
        );
      }
      return Array.from(mints);
    },

    publish: async (event: BuyEvent): Promise<PublishResult> => {
      const skipped: string[] = [];
      if (postedSignatures.get(event.signature)) {
        return { posted: 0, skipped: ["duplicate"] };
      }

      const targets = deps.chatDb
        .getEnabledChatBuyAlerts()
        .filter((config) => matchesMint(config.chat_id, event.mint))
        .filter((config) => {
          if (belowMinimum(config.chat_id, event.solAmount)) {
            skipped.push(`dust:${config.chat_id}`);
            return false;
          }
          return true;
        })
        .filter((config) => {
          if (!allowChat(config.chat_id)) {
            skipped.push(`rate:${config.chat_id}`);
            return false;
          }
          return true;
        });

      if (targets.length === 0) {
        return { posted: 0, skipped };
      }

      postedSignatures.setWithTTL(event.signature, true);
      const [pair, solPriceUsd, enriched] = await Promise.all([
        fetchPairStats(event.mint),
        deps.fetchSolPriceUsd ? deps.fetchSolPriceUsd() : Promise.resolve(null),
        enrichEvent(event),
      ]);

      let posted = 0;
      for (const config of targets) {
        if (await publishToChat(config.chat_id, enriched, pair, solPriceUsd ?? null)) {
          posted += 1;
        }
      }
      return { posted, skipped };
    },

    sendTest: async (chatId: number): Promise<void> => {
      const token = resolveForChat(chatId);
      const pair = await fetchPairStats(token.mint);
      const solPriceUsd = deps.fetchSolPriceUsd ? await deps.fetchSolPriceUsd() : null;
      const event: BuyEvent = {
        signature: `test-${now()}`,
        mint: token.mint,
        trader: "11111111111111111111111111111112",
        solAmount: 1.8998,
        tokenAmount: 1_270_000,
        dex: pair?.dexId?.toLowerCase().includes("raydium") ? "raydium" : "pump",
        newHolder: true,
      };
      await publishToChat(chatId, event, pair, solPriceUsd ?? null);
    },
  };
}

export function resolveBuyAlertMedia(
  config: ChatBuyAlertConfig | null | undefined,
): BuyAlertMedia | null {
  const fileId = config?.media_file_id?.trim();
  if (!fileId || fileId === CHAT_MEDIA_DISABLED_SENTINEL) {
    return null;
  }
  return {
    fileId,
    mediaType: config?.media_type ?? "video",
  };
}

export function attachBuyAlertFeed(
  feed: BuyFeed,
  publish: (event: BuyEvent) => Promise<unknown>,
): void {
  feed.onTrade((event) => {
    void publish(event);
  });
}
