import { Connection, PublicKey } from "#solana";
import { fetchJupiterTokenMetadata } from "./jupiter";
import type { FetchLike } from "../types";
import { deserializeMetadata } from "@metaplex-foundation/mpl-token-metadata";

export interface TokenMetadataResult {
  decimals: number;
  symbol?: string;
  name?: string;
}

export interface TokenMetadataResolverContext {
  readonly connection: Connection;
  readonly mintAddress: string;
  readonly fetch: FetchLike;
  ensureDecimals(value?: number | null): Promise<number>;
}

export type TokenMetadataHook = (
  context: TokenMetadataResolverContext,
) => Promise<TokenMetadataResult | null>;

export interface ResolveTokenMetadataParams {
  connection: Connection;
  mintAddress: string;
  fetch?: FetchLike;
  getDecimals?: () => Promise<number | null>;
  defaultDecimals?: number;
  hooks?: TokenMetadataHook[];
}

const METAPLEX_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

async function tryMetaplexMetadata(
  connection: Connection,
  mintAddress: string,
  ensureDecimals: (value?: number | null) => Promise<number>,
): Promise<TokenMetadataResult | null> {
  try {
    const mint = new PublicKey(mintAddress);
    const metadataPda = (
      await PublicKey.findProgramAddress(
        [Buffer.from("metadata"), METAPLEX_PROGRAM_ID.toBuffer(), mint.toBuffer()],
        METAPLEX_PROGRAM_ID,
      )
    )[0];

    const metadataAccount = await connection.getAccountInfo(metadataPda);
    if (!metadataAccount?.data) {
      return null;
    }
    const metadata = deserializeMetadata(metadataAccount as any);
    const rawSymbol = (metadata as any).symbol ?? "";
    const rawName = (metadata as any).name ?? "";
    const symbol = String(rawSymbol).replace(/\0/g, "").trim();
    const name = String(rawName).replace(/\0/g, "").trim();

    if (symbol && symbol !== "UNKNOWN") {
      return {
        symbol,
        name: name || symbol,
        decimals: await ensureDecimals(),
      };
    }
  } catch (error) {
    console.log("Metaplex metadata not available for", mintAddress, error);
  }

  return null;
}

export async function resolveTokenMetadata({
  connection,
  mintAddress,
  fetch,
  getDecimals,
  defaultDecimals = 0,
  hooks = [],
}: ResolveTokenMetadataParams): Promise<TokenMetadataResult> {
  let cachedDecimals: number | null = null;
  const ensureDecimals = async (value?: number | null): Promise<number> => {
    if (typeof value === "number" && Number.isFinite(value)) {
      cachedDecimals = value;
      return value;
    }

    if (cachedDecimals !== null) {
      return cachedDecimals;
    }

    if (getDecimals) {
      try {
        const resolved = await getDecimals();
        if (typeof resolved === "number" && Number.isFinite(resolved)) {
          cachedDecimals = resolved;
          return resolved;
        }
      } catch (error) {
        console.warn(`Token metadata decimals resolver failed for ${mintAddress}:`, error);
      }
    }

    cachedDecimals = defaultDecimals;
    return defaultDecimals;
  };

  const fetchImpl: FetchLike = fetch ?? (globalThis.fetch as unknown as FetchLike);

  const metaplexResult = await tryMetaplexMetadata(connection, mintAddress, ensureDecimals);
  if (metaplexResult) {
    return metaplexResult;
  }

  const context: TokenMetadataResolverContext = {
    connection,
    mintAddress,
    fetch: fetchImpl,
    ensureDecimals,
  };

  for (const hook of hooks) {
    try {
      const result = await hook(context);
      if (result) {
        return {
          ...result,
          decimals: await ensureDecimals(result.decimals),
        };
      }
    } catch (error) {
      console.warn(`Token metadata hook failed for ${mintAddress}:`, error);
    }
  }

  try {
    const metadata = await fetchJupiterTokenMetadata(mintAddress, fetchImpl);
    if (metadata) {
      return {
        symbol: metadata.symbol,
        name: metadata.name || metadata.symbol,
        decimals: await ensureDecimals(metadata.decimals),
      };
    }
  } catch (error) {
    console.log("Jupiter token search not available for", mintAddress, error);
  }

  return {
    decimals: await ensureDecimals(),
  };
}
