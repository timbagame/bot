/**
 * Drives the real bot (src/bot.ts) through `bot.handleUpdate`, recording every
 * Telegram API call instead of sending it. Tests stub the wallet and other
 * singletons they need and restore them with `restoreStubs()`.
 */
process.env.TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "TEST_TOKEN";
process.env.MNEMONIC =
  process.env.MNEMONIC || "test walk nut penalty hip pave soap entry language right filter choice";
process.env.SOLANA_NETWORK = process.env.SOLANA_NETWORK || "http://localhost:8899";
process.env.NODE_ENV = "test";

export type ApiCall = { method: string; payload: any; result?: any };

export const botModule = await import("../../src/bot");
export const bot: any = botModule.bot;
export const wallet: any = botModule.wallet;

const BOT_INFO = {
  id: 424_242,
  is_bot: true,
  first_name: "test-bot",
  username: "test_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
};

export const calls: ApiCall[] = [];
let nextMessageId = 500_000;
let updateId = 9_000_000;
const methodOverrides = new Map<string, (payload: any) => unknown>();

const transformer = async (_prev: unknown, method: string, payload: any) => {
  const call: ApiCall = { method, payload };
  calls.push(call);
  const response = await respond(method, payload);
  call.result = response.result;
  return response;
};

const respond = async (method: string, payload: any): Promise<any> => {
  const override = methodOverrides.get(method);
  if (override) {
    const result = await override(payload);
    if (result && typeof result === "object" && (result as any).ok === false) return result;
    return { ok: true, result };
  }
  if (method.startsWith("send") || method === "copyMessage") {
    return {
      ok: true,
      result: {
        message_id: ++nextMessageId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: payload.chat_id, type: payload.chat_id > 0 ? "private" : "supergroup" },
        text: payload.text,
      },
    };
  }
  if (method.startsWith("editMessage")) {
    return {
      ok: true,
      result: {
        message_id: payload.message_id,
        date: Math.floor(Date.now() / 1000),
        chat: { id: payload.chat_id, type: "private" },
        text: payload.text,
      },
    };
  }
  if (method === "getChatMember") {
    return { ok: true, result: { status: "member", user: { id: payload.user_id } } };
  }
  if (method === "getChat") {
    return { ok: true, result: { id: payload.chat_id, type: "supergroup", title: "Group" } };
  }
  return { ok: true, result: true };
};

/** Message id of a recorded send (or the edited message's id). */
export const messageIdOf = (call: ApiCall | undefined): number =>
  call?.result?.message_id ?? call?.payload?.message_id;

/**
 * Install the recorder as the outermost API transformer. Call it at the top of
 * every test file that uses this harness: other suites install their own
 * transformers on the shared bot, and the last one installed wins.
 */
export const useBotHarness = () => {
  bot.botInfo = { ...BOT_INFO };
  bot.api.config.use(transformer);
};

/** Make the next calls to `method` return `result(payload)` (or throw from it). */
export const overrideApiMethod = (method: string, result: (payload: any) => unknown) => {
  methodOverrides.set(method, result);
};

/** Make `method` fail the way Telegram does (the bot sees a GrammyError). */
export const failApiMethod = (method: string, description: string, errorCode = 400) => {
  methodOverrides.set(method, () => ({ ok: false, error_code: errorCode, description }));
};

export const clearApiOverride = (method: string) => {
  methodOverrides.delete(method);
};

export const resetCalls = () => {
  calls.length = 0;
  methodOverrides.clear();
};

export const callsTo = (method: string) => calls.filter((call) => call.method === method);
export const lastCall = (method: string) => callsTo(method).at(-1);
const isMessageCall = (call: ApiCall) =>
  (call.method.startsWith("send") || call.method.startsWith("editMessage")) &&
  (typeof call.payload?.text === "string" || typeof call.payload?.caption === "string");
/** Every call that sent or edited a message (text or caption), oldest first. */
export const messageCalls = () => calls.filter(isMessageCall);
export const lastMessage = () => messageCalls().at(-1);
export const messageText = (call: ApiCall | undefined) =>
  (call?.payload?.text ?? call?.payload?.caption ?? "") as string;
/** Text of every message the bot sent or edited, oldest first. */
export const texts = () => messageCalls().map(messageText);
export const lastText = () => texts().at(-1);
export const answers = () =>
  callsTo("answerCallbackQuery").map((call) => call.payload.text as string | undefined);
export const buttons = (call: ApiCall | undefined) =>
  ((call?.payload?.reply_markup?.inline_keyboard ?? []) as any[][])
    .flat()
    .map((button) => ({ text: button.text as string, data: button.callback_data as string }));

type ChatOptions = {
  userId?: number;
  chatId?: number;
  chatType?: "private" | "group" | "supergroup";
  username?: string;
};

const chatFor = ({
  chatId,
  chatType,
  userId,
}: Required<Pick<ChatOptions, "userId">> & ChatOptions) => {
  const id = chatId ?? userId;
  const type = chatType ?? (id > 0 ? "private" : "supergroup");
  return type === "private"
    ? { id, type, first_name: "Tester" }
    : { id, type, title: "Test Group" };
};

export const sendText = async (
  text: string,
  options: ChatOptions & { replyTo?: number; messageId?: number } = {},
) => {
  const userId = options.userId ?? 1001;
  const messageId = options.messageId ?? ++nextMessageId;
  const chat = chatFor({ ...options, userId });
  const command = text.startsWith("/") ? text.split(/\s+/)[0]! : undefined;
  await bot.handleUpdate({
    update_id: ++updateId,
    message: {
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
      chat,
      from: {
        id: userId,
        is_bot: false,
        first_name: "Tester",
        ...(options.username ? { username: options.username } : {}),
      },
      text,
      ...(command
        ? { entities: [{ type: "bot_command", offset: 0, length: command.length }] }
        : {}),
      ...(options.replyTo
        ? {
            reply_to_message: {
              message_id: options.replyTo,
              date: Math.floor(Date.now() / 1000),
              chat,
              from: { id: bot.botInfo.id, is_bot: true, first_name: "test-bot" },
              text: "prompt",
            },
          }
        : {}),
    },
  });
  return messageId;
};

export const press = async (
  data: string,
  options: ChatOptions & { messageId?: number; messageText?: string } = {},
) => {
  const userId = options.userId ?? 1001;
  const id = ++updateId;
  await bot.handleUpdate({
    update_id: id,
    callback_query: {
      id: `cb-${id}`,
      from: { id: userId, is_bot: false, first_name: "Tester" },
      chat_instance: "instance",
      data,
      message: {
        message_id: options.messageId ?? 77,
        date: Math.floor(Date.now() / 1000),
        chat: chatFor({ ...options, userId }),
        from: { id: bot.botInfo.id, is_bot: true, first_name: "test-bot" },
        text: options.messageText ?? "menu",
      },
    },
  });
};

const restorers: Array<() => void> = [];

/** Replace `target[key]` until `restoreStubs()` runs. */
export const stub = <T extends object, K extends keyof T>(target: T, key: K, value: T[K]) => {
  const hadOwn = Object.prototype.hasOwnProperty.call(target, key);
  const original = target[key];
  target[key] = value;
  restorers.push(() => {
    if (hadOwn) target[key] = original;
    else delete target[key];
  });
};

export const restoreStubs = () => {
  while (restorers.length > 0) restorers.pop()!();
};
