import * as fs from "fs";
import * as path from "path";
import { Keypair } from "#solana";

export const ORACLE_OPERATOR_KEYPAIR_ENV = "ORACLE_OPERATOR_KEYPAIR_PATH";

type PublicKeyLike = { toBase58(): string };

type SignerLike = {
  publicKey: PublicKeyLike;
};

const resolvePath = (filePath: string): string =>
  path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);

const readSecretKey = (resolvedPath: string): Uint8Array => {
  const raw = JSON.parse(fs.readFileSync(resolvedPath, "utf-8"));
  return Uint8Array.from(raw);
};

export const loadKeypairFromPath = (filePath: string): Keypair => {
  const resolvedPath = resolvePath(filePath);
  try {
    const secret = readSecretKey(resolvedPath);
    return Keypair.fromSecretKey(secret);
  } catch (error) {
    throw new Error(`Failed to load keypair from ${resolvedPath}: ${error}`, { cause: error });
  }
};

type OracleOperatorOptions = {
  envVar?: string;
  description?: string;
};

export const resolveKeypairFromEnv = (
  envVarName: string,
  fallback: Keypair,
  roleDescription: string,
): Keypair => {
  const configuredPath = process.env[envVarName]?.trim();
  if (!configuredPath) {
    console.log(
      `${roleDescription}: env ${envVarName} not set; using fallback ${fallback.publicKey.toBase58()}`,
    );
    return fallback;
  }

  try {
    const keypair = loadKeypairFromPath(configuredPath);
    console.log(
      `${roleDescription}: loaded ${keypair.publicKey.toBase58()} from ${configuredPath}`,
    );
    return keypair;
  } catch (error) {
    throw new Error(`${roleDescription}: failed to load keypair from ${configuredPath}: ${error}`, {
      cause: error,
    });
  }
};

export const resolveOracleOperatorKeypair = (
  fallback: Keypair,
  options: OracleOperatorOptions = {},
): Keypair => {
  const envVar = options.envVar ?? ORACLE_OPERATOR_KEYPAIR_ENV;
  const description = options.description ?? "Oracle operator keypair";
  return resolveKeypairFromEnv(envVar, fallback, description);
};

export const uniqueSigners = <T extends SignerLike>(...signers: (T | null | undefined)[]): T[] => {
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const signer of signers) {
    if (!signer) continue;
    const key = signer.publicKey.toBase58();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(signer);
  }
  return deduped;
};
