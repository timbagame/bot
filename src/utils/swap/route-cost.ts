export interface RouteLikeCosts {
  rentFeeLamports?: number | null;
  prioritizationFeeLamports?: number | null;
  signatureFeeLamports?: number | null;
}

export type RouteCostCombineStrategy = "sum" | "max";

export type RouteCostConfig = {
  paddingRatio?: number;
  paddingExtraLamports?: number;
  minPaddingLamports?: number;
  paddingRounding?: "ceil" | "round";
  baseRequiredLamports?: number;
  requiredStrategy?: RouteCostCombineStrategy;
};

export type RouteCostSummary = {
  routeLamports: number;
  paddingLamports: number;
  requiredLamports: number;
};

export const DEFAULT_ROUTE_LAMPORTS_PADDING = 400_000;

const clampNumber = (value: number): number => {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.trunc(value));
};

const roundPadding = (value: number, rounding: "ceil" | "round"): number => {
  return rounding === "round" ? Math.round(value) : Math.ceil(value);
};

export const calculateRouteCosts = (
  costs: RouteLikeCosts | null | undefined,
  config?: RouteCostConfig,
): RouteCostSummary => {
  const routeLamports = Math.max(
    0,
    (costs?.rentFeeLamports ?? 0) +
      (costs?.prioritizationFeeLamports ?? 0) +
      (costs?.signatureFeeLamports ?? 0),
  );

  const paddingRatio = config?.paddingRatio ?? 0.25;
  const paddingExtraLamports = config?.paddingExtraLamports ?? 0;
  const minPaddingLamports = config?.minPaddingLamports ?? 0;
  const paddingRounding = config?.paddingRounding ?? "ceil";

  const ratioPadding = roundPadding(routeLamports * paddingRatio, paddingRounding);
  let paddingLamports = clampNumber(ratioPadding + paddingExtraLamports);

  if (routeLamports > 0) {
    paddingLamports = Math.max(paddingLamports, minPaddingLamports);
  }

  const baseRequiredLamports = Math.max(0, config?.baseRequiredLamports ?? 0);
  const requiredStrategy = config?.requiredStrategy ?? "max";

  const requiredLamports =
    requiredStrategy === "sum"
      ? routeLamports + paddingLamports + baseRequiredLamports
      : Math.max(routeLamports, paddingLamports, baseRequiredLamports);

  return {
    routeLamports,
    paddingLamports,
    requiredLamports,
  };
};
