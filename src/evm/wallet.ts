import { mnemonicToAccount } from "viem/accounts";

/** BIP-39 passphrase is the decimal Telegram ID, matching the existing wallet backup convention.
 * EVM uses standard BIP-44 m/44'/60'/0'/0/0 (secp256k1), never a Solana secret key.
 */
export function evmAccount(mnemonic: string, telegramId: string) {
  if (!/^[1-9][0-9]*$/.test(telegramId) || BigInt(telegramId) > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("Invalid Telegram wallet identity");
  return mnemonicToAccount(mnemonic, { passphrase: telegramId, path: "m/44'/60'/0'/0/0" });
}
