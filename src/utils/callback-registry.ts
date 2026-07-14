import type { Bot, Context, NextFunction } from "grammy";

export type CallbackPrefixHandlerOptions = {
  logLabel?: string;
  errorAck?: string;
};

export type CallbackPrefixContext = {
  raw: string;
  payload: string;
};

export type CallbackPrefixHandler = (
  ctx: Context,
  data: CallbackPrefixContext,
  next: () => Promise<void>,
) => Promise<void> | void;

export type WrapCallbackHandler = <TCtx extends Context>(
  handler: (ctx: TCtx, next: NextFunction) => Promise<void> | void,
  options?: { action?: string; errorAck?: string },
) => (ctx: TCtx, next: NextFunction) => Promise<void>;

export type RegisterCallbackPrefixHandler = (
  prefix: string,
  handler: CallbackPrefixHandler,
  options?: CallbackPrefixHandlerOptions,
) => void;

export const createCallbackPrefixRegistrar = ({
  bot,
  wrapCallbackHandler,
}: {
  bot: Bot;
  wrapCallbackHandler: WrapCallbackHandler;
}): RegisterCallbackPrefixHandler => {
  return (prefix, handler, options = {}) => {
    bot.on(
      "callback_query",
      wrapCallbackHandler(
        async (ctx, next) => {
          const callbackData = ctx.callbackQuery?.data;
          if (!callbackData?.startsWith(prefix)) {
            return await next();
          }

          const payload = callbackData.slice(prefix.length);
          await handler(ctx, { raw: callbackData, payload }, () => next());
        },
        {
          action: options.logLabel ?? `${prefix} handler`,
          errorAck: options.errorAck,
        },
      ),
    );
  };
};
