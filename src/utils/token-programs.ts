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
): Promise<TokenProgramDetection> {
  try {
    const mintKey = typeof mint === "string" ? new PublicKey(mint) : mint;
    const accountInfo =
      preloadedAccountInfo ?? ((await connection.getAccountInfo(mintKey)) as AccountInfoLike | null);

    if (!accountInfo || !accountInfo.owner) {
      return { programId: TOKEN_PROGRAM_ID, isToken2022: false };
    }

    const owner = accountInfo.owner as PublicKey & {
      equals?: (other: PublicKey) => boolean;
    };

    const isToken2022 = Boolean(
      owner && typeof owner.equals === "function" && owner.equals(TOKEN_2022_PROGRAM_ID)
    );

    return {
      programId: isToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID,
      isToken2022,
    };
  } catch (error) {
    const mintAddress = typeof mint === "string" ? mint : mint.toBase58();
    console.log(`Error checking token program for ${mintAddress}:`, error);
    return { programId: TOKEN_PROGRAM_ID, isToken2022: false };
  }
}
