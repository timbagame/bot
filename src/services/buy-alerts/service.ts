import type { InlineKeyboard } from "grammy";
import type { ChatDatabase } from "../../utils/chat-database";
import { createPoolTradePoller } from "./pool-trades";
import {
  attachBuyAlertFeed,
  createBuyAlertPublisher,
  type BuyAlertMedia,
  type BuyAlertTokenSource,
} from "./publisher";
import type { BuyEvent, BuyFeed } from "./types";

export type BuyAlertService = {
  start: () => void;
  stop: () => void;
  refresh: () => void;
  sendTest: (chatId: number) => Promise<void>;
  ingest: (event: BuyEvent) => Promise<void>;
};

export type CreateBuyAlertServiceDeps = {
  chatDb: ChatDatabase;
  getTokenManager: () => BuyAlertTokenSource;
  sendHtml: (
    chatId: number,
    text: string,
    media?: BuyAlertMedia | null,
    keyboard?: InlineKeyboard,
  ) => Promise<void>;
  fetchSolPriceUsd?: () => Promise<number | null>;
  resolveNewHolder?: (event: BuyEvent) => Promise<boolean | null>;
  feed?: BuyFeed;
  getBotUsername?: () => string | undefined;
};

export function createBuyAlertService(deps: CreateBuyAlertServiceDeps): BuyAlertService {
  const feeds: BuyFeed[] = [deps.feed ?? createPoolTradePoller()];
  const publisher = createBuyAlertPublisher({
    chatDb: deps.chatDb,
    tokenManager: {
      getChatDefaultToken: (chatId) => deps.getTokenManager().getChatDefaultToken(chatId),
      getDefaultToken: () => deps.getTokenManager().getDefaultToken(),
    },
    sendHtml: deps.sendHtml,
    fetchSolPriceUsd: deps.fetchSolPriceUsd,
    resolveNewHolder: deps.resolveNewHolder,
    getBotUsername: deps.getBotUsername,
  });

  for (const feed of feeds) {
    attachBuyAlertFeed(feed, (event) => publisher.publish(event));
  }

  const refresh = () => {
    const mints = publisher.watchedMints();
    for (const feed of feeds) {
      feed.setMints(mints);
    }
  };

  return {
    start: refresh,
    stop: () => {
      for (const feed of feeds) {
        feed.stop();
      }
    },
    refresh,
    sendTest: (chatId) => publisher.sendTest(chatId),
    ingest: async (event) => {
      await publisher.publish(event);
    },
  };
}
