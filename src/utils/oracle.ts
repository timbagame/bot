import { Transaction, type PublicKey } from "@solana/web3.js";
import type { AuthorizationResult, OracleStats } from "../types";
import { GameDatabase } from "./game-database";
import type { WalletManager } from "./wallet";
import { loadOracleApiToken } from "./secrets";
import { createRestClient, expectStatus, ProtocolHttpError } from "@timbagame/protocol/common";
import {
  oracleContract,
  type CreationPolicyRejection,
  type CreationPolicyRejectionCode,
  type TokenPolicy,
} from "@timbagame/protocol/oracle";

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

const POLICY_REJECTION_CODES = new Set<CreationPolicyRejectionCode>([
  "unsupported_mint",
  "token_disabled",
  "amount_below_minimum",
  "policy_unavailable",
]);

const TOKEN_POLICY_CACHE_TTL_MS = 5_000;

function isCreationPolicyRejection(value: unknown): value is CreationPolicyRejection {
  if (typeof value !== "object" || value === null || !("code" in value)) return false;
  return POLICY_REJECTION_CODES.has((value as { code: CreationPolicyRejectionCode }).code);
}

export class OraclePolicyError extends Error {
  constructor(
    readonly code: CreationPolicyRejectionCode,
    message: string,
    readonly details: {
      mint?: string;
      minimumAmountRaw?: string;
      acceptedMinimumAmountRaw?: string;
      revision?: number;
    } = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "OraclePolicyError";
  }
}

function policyErrorFromHttpError(error: unknown): OraclePolicyError | null {
  if (!(error instanceof ProtocolHttpError) || !isCreationPolicyRejection(error.data)) {
    return null;
  }
  const {
    code,
    error: message,
    mint,
    minimumAmountRaw,
    acceptedMinimumAmountRaw,
    revision,
  } = error.data;
  return new OraclePolicyError(
    code,
    message,
    { mint, minimumAmountRaw, acceptedMinimumAmountRaw, revision },
    { cause: error },
  );
}

export function formatOraclePolicyError(error: unknown): string | null {
  if (!(error instanceof OraclePolicyError)) return null;
  switch (error.code) {
    case "unsupported_mint":
      return "❌ This token is not supported for new games.";
    case "token_disabled":
      return "❌ This token is temporarily disabled for new games.";
    case "amount_below_minimum":
      return "❌ The game amount is below the current minimum for this token.";
    case "policy_unavailable":
      return "❌ Token policy is unavailable. Please try again later.";
  }
}

// ================================
// ORACLE API CLIENT
// ================================

export class OracleClient {
  private static instance: OracleClient;
  private gameDb: GameDatabase;
  private oracleApiUrl: string;
  private wallet?: WalletManager;
  private tokenPolicyCache?: {
    oracleApiUrl: string;
    policies: TokenPolicy[];
    expiresAt: number;
  };
  private tokenPolicyRequest?: {
    oracleApiUrl: string;
    promise: Promise<TokenPolicy[]>;
  };

  private constructor() {
    this.gameDb = GameDatabase.getInstance();
    this.oracleApiUrl = process.env["ORACLE_API_URL"] || "http://localhost:3001";
  }

  public static getInstance(wallet?: WalletManager): OracleClient {
    if (!OracleClient.instance) {
      OracleClient.instance = new OracleClient();
    }
    if (wallet) {
      OracleClient.instance.wallet = wallet;
    }
    return OracleClient.instance;
  }

  // ================================
  // ORACLE API METHODS
  // ================================

  private apiClient() {
    return createRestClient(oracleContract, {
      baseUrl: this.oracleApiUrl,
      getHeaders: (endpoint) => {
        const apiToken = loadOracleApiToken();
        const headers: Record<string, string> = {};
        if (endpoint.authenticated && apiToken) {
          headers["Authorization"] = `Bearer ${apiToken}`;
        }
        return headers;
      },
    });
  }

  /**
   * Request a random hash from the oracle API for game creation
   */
  public async generateGameSecrets(): Promise<{ randomHash: string; oracleOperator: string }> {
    try {
      const data = expectStatus(await this.apiClient().generateHash({ body: {} }), 200).data;

      console.log(`✅ Generated random hash from oracle: ${data.randomHash}`);

      return {
        randomHash: data.randomHash,
        oracleOperator: data.oracleOperator,
      };
    } catch (error) {
      console.error("❌ Error requesting random hash from oracle:", error);
      throw new Error(`Oracle API unavailable: ${(error as Error).message}`, { cause: error });
    }
  }

  public async signGameTransaction(transaction: Transaction): Promise<Transaction> {
    const txBase64 = transaction
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString("base64");
    try {
      const data = expectStatus(
        await this.apiClient().signGameTransaction({ body: { txBase64 } }),
        200,
      ).data;
      return Transaction.from(Buffer.from(data.txBase64, "base64"));
    } catch (error) {
      throw policyErrorFromHttpError(error) ?? error;
    }
  }

  public async getTokenPolicies(): Promise<TokenPolicy[]> {
    const oracleApiUrl = this.oracleApiUrl;
    const now = Date.now();
    if (
      this.tokenPolicyCache?.oracleApiUrl === oracleApiUrl &&
      this.tokenPolicyCache.expiresAt > now
    ) {
      return this.tokenPolicyCache.policies;
    }

    if (this.tokenPolicyRequest?.oracleApiUrl === oracleApiUrl) {
      return this.tokenPolicyRequest.promise;
    }

    const promise = (async () => {
      try {
        const policies = expectStatus(await this.apiClient().tokenPolicies(), 200).data.policies;
        if (this.oracleApiUrl === oracleApiUrl) {
          this.tokenPolicyCache = {
            oracleApiUrl,
            policies,
            expiresAt: Date.now() + TOKEN_POLICY_CACHE_TTL_MS,
          };
        }
        return policies;
      } catch (error) {
        throw (
          policyErrorFromHttpError(error) ??
          new OraclePolicyError(
            "policy_unavailable",
            "Unable to load the Oracle token policy",
            {},
            { cause: error },
          )
        );
      }
    })();

    this.tokenPolicyRequest = { oracleApiUrl, promise };
    try {
      return await promise;
    } finally {
      if (this.tokenPolicyRequest?.promise === promise) {
        this.tokenPolicyRequest = undefined;
      }
    }
  }

  public async requireTokenPolicy(mint: string, amountRaw?: bigint): Promise<TokenPolicy> {
    const policy = (await this.getTokenPolicies()).find((candidate) => candidate.mint === mint);
    if (!policy) {
      throw new OraclePolicyError("unsupported_mint", "Token is not supported", { mint });
    }
    if (!policy.enabled) {
      throw new OraclePolicyError("token_disabled", "Token is disabled", {
        mint: policy.mint,
        revision: policy.revision,
      });
    }
    if (amountRaw !== undefined && amountRaw < BigInt(policy.acceptedMinimumAmountRaw)) {
      throw new OraclePolicyError("amount_below_minimum", "Amount is below the token minimum", {
        mint: policy.mint,
        minimumAmountRaw: policy.minimumAmountRaw,
        acceptedMinimumAmountRaw: policy.acceptedMinimumAmountRaw,
        revision: policy.revision,
      });
    }
    return policy;
  }

  /**
   * Get oracle statistics
   */
  public async getStats(): Promise<OracleStats | null> {
    try {
      const data = expectStatus(await this.apiClient().stats(), 200).data;

      return data.stats;
    } catch (error) {
      console.warn("Error fetching oracle stats:", error);
      return null;
    }
  }

  /**
   * Check if oracle API is healthy
   */
  public async isHealthy(): Promise<boolean> {
    try {
      console.log(`🔍 Checking Oracle health at: ${this.oracleApiUrl}/health`);
      const result = await this.apiClient().health({
        request: { signal: AbortSignal.timeout(5000) },
      });

      console.log(
        `🔍 Oracle health response: ${result.response.status} ${result.response.statusText}`,
      );
      expectStatus(result, 200);
      return true;
    } catch (error) {
      console.error("❌ Oracle health check failed:", {
        url: `${this.oracleApiUrl}/health`,
        error: error instanceof Error ? error.message : String(error),
        type: error?.constructor?.name || typeof error,
        code: errorCode(error),
      });
      return false;
    }
  }

  public async requestGameCompletion(gameAddress: string): Promise<boolean> {
    try {
      expectStatus(
        await this.apiClient().completeGameNow({
          body: { gameAddress },
          request: { signal: AbortSignal.timeout(3000) },
        }),
        200,
      );
      return true;
    } catch (error) {
      console.warn(`Oracle completion wake-up failed for ${gameAddress}:`, error);
      return false;
    }
  }

  // ================================
  // PRIVATE GAME AUTHORIZATION (kept for private games)
  // ================================

  public async authorizePlayer(gamePda: PublicKey, chatId: number): Promise<AuthorizationResult> {
    try {
      const game = this.gameDb.getGame(gamePda.toBase58());
      if (!game) {
        return { authorized: false, error: "Game not found in database" };
      }

      if (!game.chat_id || game.chat_id !== chatId) {
        return {
          authorized: false,
          error: "Player not in same chat as game creator",
        };
      }

      // Private games require the shared operator keypair for authorization.
      if (!this.wallet) {
        return { authorized: false, error: "Wallet manager not available" };
      }

      const operatorKeypair = this.wallet.getOperatorKeypair();
      return { authorized: true, operatorKeypair };
    } catch (error) {
      console.error(`Error authorizing player:`, error);
      return {
        authorized: false,
        error: "Unable to authorize this private-game join. Please try again shortly.",
      };
    }
  }

  // ================================
  // UTILITY METHODS
  // ================================

  /**
   * Convert hex string to Buffer (for random hash)
   */
  public hexToBuffer(hex: string): Buffer {
    return Buffer.from(hex, "hex");
  }

  /**
   * Get oracle API URL
   */
  public getOracleUrl(): string {
    return this.oracleApiUrl;
  }

  /**
   * Set oracle API URL (for testing or different environments)
   */
  public setOracleUrl(url: string): void {
    this.oracleApiUrl = url;
    this.tokenPolicyCache = undefined;
  }
}
