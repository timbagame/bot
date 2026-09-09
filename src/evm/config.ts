import { readFileSync } from "node:fs";
import { getAddress } from "viem";
import { z } from "zod";

export const evmBotConfigSchema = z.strictObject({
  chainId: z.number().int().positive().safe(),
  address: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .transform((value) => getAddress(value)),
  version: z.literal("0.1.0"),
  name: z.string().regex(/^[a-zA-Z0-9 -]{1,40}$/),
  rpcUrls: z.array(z.url()).min(1),
  oracleUrl: z.url(),
  oracleTokenFile: z.string().min(1),
  database: z.string().min(1),
  webUrl: z.url(),
  confirmations: z.number().int().min(1).max(256).default(2),
});
export type EvmBotConfig = z.output<typeof evmBotConfigSchema>;
export function loadEvmBotConfig(file: string) {
  return evmBotConfigSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}
