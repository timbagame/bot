export interface ReferralTokenConfigEntry {
  mint: string;
  referralAccount: string;
  baseFeeBps?: number;
  adminPayer?: string;
  adminCloseAuthority?: string;
  maxExtraFeeBps?: number;
}

const normalizeMint = (mint: string): string => mint.trim();

const parseReferralConfig = (): Map<string, ReferralTokenConfigEntry> => {
  const raw = process.env["JUPITER_REFERRAL_CONFIG"];
  if (!raw) {
    return new Map();
  }

  try {
    const parsed = JSON.parse(raw) as ReferralTokenConfigEntry[];
    const entries = Array.isArray(parsed) ? parsed : [];
    return new Map(
      entries
        .filter(
          (entry) =>
            entry &&
            typeof entry.mint === "string" &&
            typeof entry.referralAccount === "string"
        )
        .map((entry) => [normalizeMint(entry.mint), entry])
    );
  } catch (error) {
    console.warn("Failed to parse JUPITER_REFERRAL_CONFIG:", error);
    return new Map();
  }
};

export const REFERRAL_CONFIG_MAP = parseReferralConfig();

export const getReferralConfigForMint = (
  mint?: string | null
): ReferralTokenConfigEntry | undefined => {
  if (!mint) return undefined;
  return REFERRAL_CONFIG_MAP.get(normalizeMint(mint));
};

export const DEFAULT_REFERRAL_BASE_FEE_BPS = 85;
export const MAX_REFERRAL_FEE_BPS = 255;
export const DEFAULT_MAX_EXTRA_FEE_BPS = 100;

export const __test_resetReferralConfigCache = () => {
  REFERRAL_CONFIG_MAP.clear();
};
