import { InlineKeyboard } from "grammy";
import {
  DEFAULT_GAME_TIMEOUT,
  DEFAULT_TOKEN_TICKER,
  MAX_GAME_TIMEOUT,
  MIN_COINFLIP_PLAYERS,
  MIN_GAME_TIMEOUT,
  MIN_GIVEAWAY_PLAYERS,
} from "./constants";
import { clampMinPlayers, clampTimeoutSeconds } from "./game-settings";
import {
  CALLBACK_DATA_LIMIT,
  decodeGameConfirmPayload,
  encodeCustomPlayersPayload,
  encodeAmountSelectionPayload,
  encodeGameConfirmPayload,
  encodeMinPlayersChangePayload,
  encodePlayersSelectionPayload,
  encodeTimeoutChangePayload,
  encodeVisibilityPayload,
  isCallbackSafeLength,
} from "./callback-data";
import { formatCompactTokenDisplay, formatTokenDisplay, formatUsdValue } from "./format-amount";
import { formatDuration } from "./format-time";
import type { GameType } from "../types";

export type WalletPagination = { page: number; pageCount: number };

export const createWalletKeyboard = (
  pagination?: WalletPagination,
  actions = {
    swap: "cmd_swap",
    withdraw: "cmd_withdraw",
    positions: "wallet_positions",
    refresh: "wallet_refresh",
    settings: "wallet_settings",
  },
): InlineKeyboard => {
  const keyboard = new InlineKeyboard();
  if (actions.swap === "cmd_swap") {
    keyboard.text("💰 Deposit", "wallet_deposit").text("💸 Withdraw", actions.withdraw).row();
    keyboard.text("🔄 Swap", actions.swap);
    if (actions.positions) keyboard.text("📊 Positions", actions.positions);
    keyboard.row().text("🔁 Refresh", actions.refresh).text("⚙️ Settings", actions.settings);
  } else {
    if (actions.swap) keyboard.text("🔄 Swap", actions.swap);
    keyboard.text("💸 Withdraw", actions.withdraw).row();
    if (actions.positions) keyboard.text("📊 Positions", actions.positions);
    keyboard.text("🔁 Refresh", actions.refresh).row().text("⚙️ Settings", actions.settings);
  }

  if (pagination && pagination.pageCount > 1) {
    keyboard.row();
    if (pagination.page > 0) {
      keyboard.text("←", `wallet_page_${pagination.page - 1}`);
    }
    if (pagination.page + 1 < pagination.pageCount) {
      keyboard.text("→", `wallet_page_${pagination.page + 1}`);
    }
  }

  return keyboard;
};

export const createPositionsKeyboard = (options: {
  page?: number;
  pageCount?: number;
}): InlineKeyboard => {
  const page = options.page ?? 0;
  const pageCount = options.pageCount ?? 1;
  const keyboard = new InlineKeyboard();

  if (pageCount > 1) {
    if (page > 0) {
      keyboard.text("←", `wallet_pos_${page - 1}`);
    }
    if (page + 1 < pageCount) {
      keyboard.text("→", `wallet_pos_${page + 1}`);
    }
    keyboard.row();
  }

  keyboard.text("🔄 Swap", "cmd_swap").text("🔁 Refresh", `wallet_pos_r_${page}`).row();
  return appendBackToWalletButton(keyboard);
};

const appendBackToWalletButton = (keyboard: InlineKeyboard): InlineKeyboard => {
  return keyboard.text("← Back to Wallet", "main_wallet").row();
};

export const createBackToWalletKeyboard = (): InlineKeyboard => {
  return appendBackToWalletButton(new InlineKeyboard());
};

export const createBackToSettingsKeyboard = (): InlineKeyboard => {
  return new InlineKeyboard().text("← Back to Settings", "wallet_settings").row();
};

export const createCancelKeyboard = (callback: string, label = "❌ Cancel"): InlineKeyboard => {
  return new InlineKeyboard().text(label, callback).row();
};

export const createWalletSettingsKeyboard = (): InlineKeyboard => {
  return appendBackToWalletButton(
    new InlineKeyboard()
      .text("🔧 Wrap SOL", "cmd_wrap")
      .text("🧼 Unwrap WSOL", "cmd_unwrap")
      .row()
      .text("🔐 Private Key", "cmd_privatekey")
      .row(),
  );
};

export const createConfirmWrapKeyboard = (lamports: number): InlineKeyboard => {
  return new InlineKeyboard()
    .text("✅ Confirm Wrap", `confirm_wrap_${String(lamports)}`)
    .row()
    .text("❌ Cancel", "cmd_wrap")
    .row();
};

export const createConfirmUnwrapKeyboard = (hasBalance: boolean): InlineKeyboard => {
  const keyboard = new InlineKeyboard();

  if (hasBalance) {
    keyboard.text("✅ Unwrap All WSOL", "unwrap_confirm").row();
  } else {
    keyboard.text("❌ No WSOL to unwrap", "noop").row();
  }

  return keyboard;
};

export const createTradeConfirmKeyboard = ({
  confirmLabel,
  confirmCallback,
  cancelLabel,
  cancelCallback,
}: {
  confirmLabel: string;
  confirmCallback: string;
  cancelLabel: string;
  cancelCallback: string;
}): InlineKeyboard => {
  return new InlineKeyboard()
    .text(confirmLabel, confirmCallback)
    .row()
    .text(cancelLabel, cancelCallback)
    .row();
};

// ================================
// GAME SETUP KEYBOARDS
// ================================

const roundToPrecision = (value: number, precision: number): number => {
  if (!Number.isFinite(value)) return 0;
  if (precision <= 0) return Math.round(value);

  const factor = Math.pow(10, precision);
  return Math.round(value * factor) / factor;
};

const withCreatorSuffix = (base: string, creatorId?: string): string =>
  creatorId ? `${base}_${creatorId}` : base;

const createOverflowKeyboard = (message = "⚠️ Unable to render options") => {
  return new InlineKeyboard().text(message, "noop").row();
};

const createCallbackGuard = () => {
  let overflowDetected = false;
  const guard = (callback: string | null | undefined): string => {
    if (callback === "noop") return callback;
    if (!callback || !isCallbackSafeLength(callback)) {
      overflowDetected = true;
      return "noop";
    }
    return callback;
  };
  return { guard, hasOverflow: () => overflowDetected };
};

/**
 * Generate fee warning message for low balance users
 */
export const getFeeWarningMessage = (
  gameType: string,
  balance: number,
  contractMinimum: number = 20,
  tokenTicker: string = DEFAULT_TOKEN_TICKER,
  options?: { includeBalanceInfo?: boolean },
): string => {
  const formattedGameType =
    typeof gameType === "string" && gameType.length > 0
      ? `${gameType.charAt(0).toUpperCase()}${gameType.slice(1)}`
      : "Game";

  const includeBalance = options?.includeBalanceInfo ?? true;

  let message = `💰 <b>Select Amount - ${formattedGameType}</b>\n\n`;

  if (includeBalance && balance < contractMinimum) {
    message += `⚠️ <b>Low Balance Warning</b>\n`;
    message += `Your balance: ${balance.toFixed(0)} ${tokenTicker}\n`;
    message += `Contract minimum: ${contractMinimum} ${tokenTicker}\n\n`;
    message += `<i>Oracle fees (~5-10%) will reduce winnings significantly with small bets.</i>\n\n`;
  } else if (balance < contractMinimum) {
    message += `⚠️ <b>Low Balance Warning</b>\n`;
    message += `Contract minimum: ${contractMinimum} ${tokenTicker}\n\n`;
    message += `<i>Oracle fees (~5-10%) can impact small bets.</i>\n\n`;
  }

  message += `Choose how much you want to play with:`;

  return message;
};

const SUGGESTION_MULTIPLIERS = [1, 2.5, 5, 10, 20, 30, 50, 75, 100, 150, 200, 250] as const;
const USD_STAKE_TARGETS = [0.25, 0.5, 1, 2, 3, 5, 7.5, 10, 15, 20, 25] as const;

type StakeSuggestion = {
  amount: number;
  usdTarget?: number;
};

export const getSuggestedStakeAmounts = (
  contractMinimum: number,
  _balance?: number,
  tokenPriceUSD?: number,
): StakeSuggestion[] => {
  const min = Math.max(contractMinimum, 0);

  const hasValidPrice =
    typeof tokenPriceUSD === "number" && Number.isFinite(tokenPriceUSD) && tokenPriceUSD > 0;

  const suggestions = hasValidPrice
    ? USD_STAKE_TARGETS.map((usdTarget) => ({
        amount: roundToPrecision(usdTarget / tokenPriceUSD, 6),
        usdTarget,
      }))
    : SUGGESTION_MULTIPLIERS.map((multiplier) => ({
        amount: roundToPrecision(min * multiplier, 6),
      }));

  const unique: StakeSuggestion[] = [];
  const eps = 1e-6;
  for (const suggestion of suggestions) {
    const value = suggestion.amount;
    if (value <= 0) continue;
    const exists = unique.some((item) => Math.abs(item.amount - value) < eps);
    if (!exists) {
      unique.push({
        ...suggestion,
        amount: Number(value.toFixed(6)),
      });
    }
  }

  return unique.length > 0 ? unique : [{ amount: min }];
};

/** Shared amount menu layout; adapters supply exact labels and callback identities. */
export const createAmountMenuKeyboard = (
  amounts: readonly { text: string; callback: string }[],
  custom: string,
  cancel: string,
): InlineKeyboard => {
  const keyboard = new InlineKeyboard();
  amounts.forEach(({ text, callback }, index) => {
    keyboard.text(text, callback);
    if (index % 2 === 1 && index < amounts.length - 1) keyboard.row();
  });
  return keyboard.row().text("✏️ Custom Amount", custom).row().text("❌ Cancel", cancel).row();
};

export const createAmountSelectionKeyboard = (
  gameType: string,
  userBalance?: number,
  creatorId?: string,
  contractMinimum: number = 20,
  options?: {
    decimals?: number;
    tokenPriceUSD?: number;
  },
): InlineKeyboard => {
  const typedGameType = gameType as GameType;
  const { guard, hasOverflow } = createCallbackGuard();

  const balance =
    typeof userBalance === "number" && Number.isFinite(userBalance)
      ? Math.max(userBalance, 0)
      : undefined;
  const decimals =
    typeof options?.decimals === "number" && Number.isFinite(options.decimals)
      ? options.decimals
      : undefined;
  const tokenPriceUSD =
    typeof options?.tokenPriceUSD === "number" &&
    Number.isFinite(options.tokenPriceUSD) &&
    options.tokenPriceUSD > 0
      ? options.tokenPriceUSD
      : undefined;

  const amounts = getSuggestedStakeAmounts(contractMinimum, balance, tokenPriceUSD);

  const minUsdText =
    tokenPriceUSD !== undefined
      ? ` ($${formatUsdValue(contractMinimum * tokenPriceUSD, {
          minimumFractionDigits: 0,
          maximumFractionDigits: 2,
        })})`
      : "";

  const amountButtons: { text: string; callback: string }[] = [];

  const minDisplay = formatCompactTokenDisplay(formatTokenDisplay(contractMinimum, { decimals }));

  amountButtons.push({
    text: `${minDisplay}${minUsdText}`,
    callback: guard(
      creatorId != null
        ? (encodeAmountSelectionPayload({
            gameType: typedGameType,
            amount: String(contractMinimum),
            creatorId,
          }) ?? withCreatorSuffix(`amount_${gameType}_${contractMinimum}`, creatorId))
        : `amount_${gameType}_${contractMinimum}`,
    ),
  });

  const filteredAmounts = amounts.filter(
    ({ amount }) => Math.abs(amount - contractMinimum) >= 1e-6,
  );

  filteredAmounts.forEach(({ amount, usdTarget }) => {
    const callbackData =
      creatorId != null
        ? (encodeAmountSelectionPayload({
            gameType: typedGameType,
            amount: String(amount),
            creatorId,
          }) ?? withCreatorSuffix(`amount_${gameType}_${amount}`, creatorId))
        : `amount_${gameType}_${amount}`;
    const fullDisplay = formatTokenDisplay(amount, { decimals });
    const display = formatCompactTokenDisplay(fullDisplay);
    let usdText = "";
    if (usdTarget !== undefined) {
      const usdFormatted = formatUsdValue(usdTarget, {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
      });
      usdText = ` ($${usdFormatted})`;
    } else if (tokenPriceUSD !== undefined) {
      const usdFormatted = formatUsdValue(amount * tokenPriceUSD, {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
      });
      usdText = ` ($${usdFormatted})`;
    }

    amountButtons.push({
      text: `${display}${usdText}`,
      callback: guard(callbackData),
    });
  });

  const result = createAmountMenuKeyboard(
    amountButtons,
    guard(withCreatorSuffix(`custom_amount_${gameType}`, creatorId)),
    guard(withCreatorSuffix("cancel_game_setup", creatorId)),
  );

  if (hasOverflow()) {
    return createOverflowKeyboard();
  }

  return result;
};

const PLAYER_SELECTION_LAYOUTS: Record<string, number[][]> = {
  coinflip: [
    [2, 3, 4],
    [5, 10, 15],
    [20, 25, 50],
  ],
  giveaway: [
    [1, 2, 3],
    [5, 10, 15],
    [20, 25, 50],
  ],
};

export const createPlayerSelectionKeyboard = (
  gameType: string,
  amount: string,
  creatorId?: string,
): InlineKeyboard => {
  const keyboard = new InlineKeyboard();
  const typedGameType = gameType as GameType;
  const { guard, hasOverflow } = createCallbackGuard();
  const layout = PLAYER_SELECTION_LAYOUTS[gameType] ?? [];

  for (const row of layout) {
    if (!Array.isArray(row) || row.length === 0) {
      continue;
    }

    for (const count of row) {
      keyboard.text(
        `👥 ${count}`,
        guard(
          creatorId != null
            ? (encodePlayersSelectionPayload({
                gameType: typedGameType,
                amount,
                players: count,
                creatorId,
              }) ?? withCreatorSuffix(`players_${gameType}_${amount}_${count}`, creatorId))
            : `players_${gameType}_${amount}_${count}`,
        ),
      );
    }

    keyboard.row();
  }

  keyboard
    .text(
      "📊 Custom Players",
      guard(
        creatorId != null
          ? (encodeCustomPlayersPayload({
              gameType: typedGameType,
              amount,
              creatorId,
            }) ?? withCreatorSuffix(`custom_players_${gameType}_${amount}`, creatorId))
          : `custom_players_${gameType}_${amount}`,
      ),
    )
    .row()
    .text("⬅️ Back to Amount", guard(withCreatorSuffix(`back_to_amounts_${gameType}`, creatorId)))
    .row();

  if (hasOverflow()) {
    return createOverflowKeyboard();
  }

  return keyboard;
};

type GameAdvancedOptions = {
  timeoutSeconds: number;
  minPlayers: number;
  isPrivate: boolean;
};

const visibilityLabel = (isPrivate: boolean): string => (isPrivate ? "🔒 Private" : "🌐 Public");

const formatTimeoutLabel = (timeoutSeconds: number): string => {
  return formatDuration(timeoutSeconds);
};

const TIMEOUT_SNAP_LADDER_SECONDS = [
  // Minutes
  5 * 60,
  10 * 60,
  15 * 60,
  20 * 60,
  30 * 60,
  45 * 60,
  // Hours (including 1h30m)
  1 * 60 * 60,
  90 * 60,
  2 * 60 * 60,
  3 * 60 * 60,
  4 * 60 * 60,
  6 * 60 * 60,
  8 * 60 * 60,
  12 * 60 * 60,
  18 * 60 * 60,
  24 * 60 * 60,
] as const;

const snapTimeoutSeconds = (candidateSeconds: number): number => {
  const clamped = clampTimeoutSeconds(candidateSeconds);
  const ladder = TIMEOUT_SNAP_LADDER_SECONDS.filter(
    (seconds) => seconds >= MIN_GAME_TIMEOUT && seconds <= MAX_GAME_TIMEOUT,
  );

  if (ladder.length === 0) return clamped;

  let best = ladder[0]!;
  let bestDiff = Math.abs(clamped - best);

  for (const seconds of ladder) {
    const diff = Math.abs(clamped - seconds);
    if (diff < bestDiff || (diff === bestDiff && seconds > best)) {
      best = seconds;
      bestDiff = diff;
    }
  }

  return best;
};

export const createGameConfirmKeyboard = (
  gameType: string,
  amount: string,
  players: string,
  creatorId?: string,
  options?: Partial<GameAdvancedOptions>,
  ui?: { lockVisibilityToPublic?: boolean },
): InlineKeyboard => {
  const fallbackMinPlayers = gameType === "coinflip" ? MIN_COINFLIP_PLAYERS : MIN_GIVEAWAY_PLAYERS;
  const advanced: GameAdvancedOptions = {
    timeoutSeconds: options?.timeoutSeconds ?? DEFAULT_GAME_TIMEOUT,
    minPlayers: options?.minPlayers ?? fallbackMinPlayers,
    isPrivate: options?.isPrivate ?? true,
  };

  const lockVisibilityToPublic = ui?.lockVisibilityToPublic === true;
  const effectiveIsPrivate = lockVisibilityToPublic ? false : advanced.isPrivate;

  const timeoutDeltaCallback = (deltaMinutes: number): string => {
    if (!creatorId) return "noop";
    const nextTimeout = clampTimeoutSeconds(advanced.timeoutSeconds + deltaMinutes * 60);
    if (nextTimeout === advanced.timeoutSeconds || deltaMinutes === 0) {
      return "noop";
    }
    return (
      encodeTimeoutChangePayload({
        gameType: typedGameType,
        amount,
        players: maxPlayersForMinPlayers,
        deltaMinutes,
        creatorId,
      }) ?? "noop"
    );
  };

  const timeoutMultiplierCallback = (multiplier: number): string => {
    if (!Number.isFinite(multiplier) || multiplier <= 0) return "noop";
    const targetTimeoutSeconds = snapTimeoutSeconds(advanced.timeoutSeconds * multiplier);
    const deltaMinutes = Math.round((targetTimeoutSeconds - advanced.timeoutSeconds) / 60);
    return timeoutDeltaCallback(deltaMinutes);
  };

  const timeoutPresetCallback = (targetSeconds: number): string => {
    const snapped = snapTimeoutSeconds(targetSeconds);
    const deltaMinutes = Math.round((snapped - advanced.timeoutSeconds) / 60);
    return timeoutDeltaCallback(deltaMinutes);
  };

  const minPlayersFloor = gameType === "coinflip" ? MIN_COINFLIP_PLAYERS : MIN_GIVEAWAY_PLAYERS;
  const playersCount = Number.parseInt(players, 10);
  const typedGameType = gameType as GameType;
  const maxPlayersForMinPlayers = Number.isFinite(playersCount)
    ? Math.max(playersCount, minPlayersFloor)
    : minPlayersFloor;

  const currentMinPlayers = clampMinPlayers(
    typedGameType,
    advanced.minPlayers,
    maxPlayersForMinPlayers,
    maxPlayersForMinPlayers,
  );

  const minPlayersDeltaCallback = (deltaPlayers: number): string => {
    if (!creatorId) return "noop";
    if (!Number.isFinite(deltaPlayers) || deltaPlayers === 0) return "noop";
    return (
      encodeMinPlayersChangePayload({
        gameType: typedGameType,
        amount,
        players: maxPlayersForMinPlayers,
        deltaPlayers,
        creatorId,
      }) ?? "noop"
    );
  };

  const minPlayersTargetCallback = (candidate: number): string => {
    if (!creatorId) return "noop";
    const target = clampMinPlayers(
      typedGameType,
      candidate,
      maxPlayersForMinPlayers,
      maxPlayersForMinPlayers,
    );
    const delta = target - currentMinPlayers;
    if (delta === 0) return "noop";
    return minPlayersDeltaCallback(delta);
  };

  const confirmCallback = creatorId
    ? (encodeGameConfirmPayload({
        gameType: typedGameType,
        amount,
        players: maxPlayersForMinPlayers,
        timeoutSeconds: advanced.timeoutSeconds,
        minPlayers: currentMinPlayers,
        isPrivate: effectiveIsPrivate,
        creatorId,
      }) ?? "noop")
    : "noop";

  const timeoutCallbacks = [
    timeoutMultiplierCallback(0.5),
    timeoutMultiplierCallback(0.75),
    "noop",
    timeoutMultiplierCallback(1.5),
    timeoutMultiplierCallback(2),
    timeoutPresetCallback(1 * 60 * 60),
    timeoutPresetCallback(6 * 60 * 60),
    timeoutPresetCallback(12 * 60 * 60),
    timeoutPresetCallback(24 * 60 * 60),
  ];

  const visibilityCallback =
    !creatorId || lockVisibilityToPublic
      ? "noop"
      : (encodeVisibilityPayload({
          gameType: typedGameType,
          amount,
          players: maxPlayersForMinPlayers,
          isPrivate: !effectiveIsPrivate,
          creatorId,
        }) ?? "noop");

  const minPlayersCallbacks = [
    minPlayersTargetCallback(Math.floor(currentMinPlayers * 0.5)),
    minPlayersTargetCallback(Math.floor(currentMinPlayers * 0.75)),
    "noop",
    minPlayersTargetCallback(Math.ceil(currentMinPlayers * 1.5)),
    minPlayersTargetCallback(maxPlayersForMinPlayers),
  ];

  const backToPlayersCallback =
    creatorId != null
      ? (encodeAmountSelectionPayload({
          gameType: typedGameType,
          amount,
          creatorId,
        }) ?? withCreatorSuffix(`amount_${gameType}_${amount}`, creatorId))
      : withCreatorSuffix(`amount_${gameType}_${amount}`, creatorId);

  const callbacksToValidate = [
    confirmCallback,
    ...timeoutCallbacks,
    visibilityCallback,
    ...minPlayersCallbacks,
    backToPlayersCallback,
  ];

  const hasOverflowingCallback = callbacksToValidate.some((callback) => {
    if (callback === "noop") return false;
    if (!callback) return true;
    return !isCallbackSafeLength(callback);
  });

  if (hasOverflowingCallback || !confirmCallback || !visibilityCallback) {
    const example = callbacksToValidate.find(
      (cb) => cb && Buffer.byteLength(cb, "utf-8") > CALLBACK_DATA_LIMIT,
    );
    const decoded = example ? decodeGameConfirmPayload(confirmCallback) : null;
    console.warn("Refusing to render confirm keyboard due to callback overflow", example, decoded);
    return createOverflowKeyboard();
  }

  const safeTimeoutCallbacks = timeoutCallbacks.map((callback) => callback ?? "noop");
  const safeMinPlayersCallbacks = minPlayersCallbacks.map((callback) => callback ?? "noop");

  const keyboard = new InlineKeyboard()
    .text("✅ Create Game", confirmCallback)
    .row()
    .text("-50%", safeTimeoutCallbacks[0]!)
    .text("-25%", safeTimeoutCallbacks[1]!)
    .text(`⏱️ ${formatTimeoutLabel(advanced.timeoutSeconds)}`, "noop")
    .text("+50%", safeTimeoutCallbacks[3]!)
    .text("+100%", safeTimeoutCallbacks[4]!)
    .row()
    .text("1h", safeTimeoutCallbacks[5]!)
    .text("6h", safeTimeoutCallbacks[6]!)
    .text("12h", safeTimeoutCallbacks[7]!)
    .text("24h", safeTimeoutCallbacks[8]!)
    .row()
    .text(`${visibilityLabel(effectiveIsPrivate)}`, visibilityCallback ?? "noop")
    .row()
    .text("-50%", safeMinPlayersCallbacks[0]!)
    .text("-25%", safeMinPlayersCallbacks[1]!)
    .text(`Min ${currentMinPlayers}`, "noop")
    .text("+50%", safeMinPlayersCallbacks[3]!)
    .text("MAX", safeMinPlayersCallbacks[4]!)
    .row()
    .text("🔙 Back to Players", backToPlayersCallback)
    .row();

  return keyboard;
};
