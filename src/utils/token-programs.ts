import { PublicKey } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";

export type TokenProgramDetection = {
  programId: PublicKey;
  isToken2022: boolean;
};

type AccountInfoLike = {
  owner?: PublicKey;
};

type AccountInfoLoader = Pick<Connection, "getAccountInfo">;

export async function detectTokenProgram(
  connection: AccountInfoLoader,
  mint: string | PublicKey,
  preloadedAccountInfo?: AccountInfoLike | null
): Promise<TokenProgramDetection | null> {
  try {
    const mintKey = typeof mint === "string" ? new PublicKey(mint) : mint;
    const accountInfo =
      preloadedAccountInfo ?? ((await connection.getAccountInfo(mintKey)) as AccountInfoLike | null);

    if (!accountInfo) {
      return null;
    }

    if (!accountInfo.owner) {
      throw new Error(`Token mint ${mintKey.toBase58()} is missing an owner`);
    }

    const owner = accountInfo.owner as PublicKey & {
      equals?: (other: PublicKey) => boolean;
    };

    const isToken2022 = Boolean(
      owner && typeof owner.equals === "function" && owner.equals(TOKEN_2022_PROGRAM_ID)
    );

    if (!isToken2022) {
      const isLegacy = Boolean(
        owner && typeof owner.equals === "function" && owner.equals(TOKEN_PROGRAM_ID)
      );

      if (!isLegacy) {
        const ownerLabel = typeof owner.toBase58 === "function" ? owner.toBase58() : String(owner);
        throw new Error(
          `Token mint ${mintKey.toBase58()} is owned by an unknown program (${ownerLabel})`
        );
      }
    }

    return {
      programId: isToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID,
      isToken2022,
    };
  } catch (error) {
    const mintAddress = typeof mint === "string" ? mint : mint.toBase58();
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "string"
        ? error
        : "";
    if (
      message.toLowerCase().includes("could not find account") ||
      message.toLowerCase().includes("not found")
    ) {
      return null;
    }
    console.log(`Error checking token program for ${mintAddress}:`, error);
    throw error;
  }
}
