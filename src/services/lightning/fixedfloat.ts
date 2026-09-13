import { createHmac } from "node:crypto";
import { z } from "zod";
import { readProtectedSecretFile } from "../../utils/secrets";

export function fixedFloatConfig(env: Readonly<Record<string, string | undefined>> = process.env) {
  if (env["FIXEDFLOAT_ENABLED"] !== "true") return null;
  const secret = (name: string) =>
    env[`${name}_FILE`] ? readProtectedSecretFile(env[`${name}_FILE`]!, name) : env[name]?.trim();
  const key = secret("FIXEDFLOAT_API_KEY");
  const apiSecret = secret("FIXEDFLOAT_API_SECRET");
  if (!key || !apiSecret) throw new Error("FixedFloat credentials are required when enabled");
  const refcode = env["FIXEDFLOAT_REFCODE"]?.trim();
  if (!refcode || !/^[A-Za-z0-9_-]{1,64}$/.test(refcode))
    throw new Error("FIXEDFLOAT_REFCODE is required when Lightning deposits are enabled");
  return { key, secret: apiSecret, refcode };
}

const decimal = z
  .union([z.string().regex(/^\d+(\.\d+)?$/), z.number().finite().nonnegative()])
  .transform(String);
const currency = z.object({
  code: z.string(),
  coin: z.string(),
  network: z.string(),
  recv: z.boolean(),
  send: z.boolean(),
});
const side = z.object({
  code: z.string(),
  amount: decimal,
  address: z.string(),
  tx: z
    .object({ id: z.string().nullable().optional(), amount: decimal.nullable().optional() })
    .optional(),
});
export const OrderSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9]{6}$/),
  token: z.string().min(1).optional(),
  type: z.enum(["fixed", "float"]),
  status: z.enum(["NEW", "PENDING", "EXCHANGE", "WITHDRAW", "DONE", "EXPIRED", "EMERGENCY"]),
  time: z.object({ expiration: z.number().int().nonnegative() }),
  from: side,
  to: side,
});
export type FixedFloatOrder = z.output<typeof OrderSchema>;
const quote = z.object({
  from: z.object({ code: z.string(), amount: decimal, min: decimal, max: decimal }),
  to: z.object({ code: z.string(), amount: decimal }),
  errors: z.array(z.string()),
});
export type FixedFloatQuote = z.output<typeof quote>;

export class FixedFloatError extends Error {
  constructor(readonly retrySafe: boolean) {
    super("FixedFloat is temporarily unavailable. Please try again later.");
  }
}

export function satsToBtc(sats: string): string {
  if (!/^[1-9]\d{0,14}$/.test(sats) || BigInt(sats) > 2_100_000_000_000_000n)
    throw new Error("Enter a positive whole number of sats.");
  return `${BigInt(sats) / 100_000_000n}.${(BigInt(sats) % 100_000_000n).toString().padStart(8, "0")}`;
}

/** Check the mainnet BOLT11 amount before showing provider payment instructions. */
export function invoiceMatchesSats(invoice: string, sats: string): boolean {
  if (invoice.length > 3000 || !/^[0-9a-z]+$/i.test(invoice)) return false;
  const match = invoice.toLowerCase().match(/^lnbc([1-9]\d*)([munp]?)1/);
  if (!match) return false;
  const units = BigInt(match[1]!);
  const scale: Record<string, bigint> = {
    "": 100_000_000_000n,
    m: 100_000_000n,
    u: 100_000n,
    n: 100n,
  };
  const msats = match[2] === "p" ? units / 10n : units * scale[match[2]!]!;
  return (match[2] !== "p" || units % 10n === 0n) && msats === BigInt(sats) * 1000n;
}

export class FixedFloatClient {
  private requests: { at: number; weight: number }[] = [];
  constructor(
    private readonly config: { key: string; secret: string; refcode: string },
    private readonly fetcher: typeof fetch = fetch,
    private readonly now = Date.now,
  ) {}
  private async call(
    method: string,
    params: Record<string, unknown>,
    weight = 1,
  ): Promise<unknown> {
    this.requests = this.requests.filter((r) => r.at > this.now() - 60_000);
    // Leave headroom below FixedFloat's shared 250 weighted requests/minute budget.
    if (this.requests.reduce((sum, r) => sum + r.weight, 0) + weight > 200)
      throw new FixedFloatError(true);
    this.requests.push({ at: this.now(), weight });
    const body = JSON.stringify(params);
    let response: Response;
    try {
      response = await this.fetcher(`https://ff.io/api/v2/${method}`, {
        method: "POST",
        redirect: "error",
        headers: {
          "Content-Type": "application/json; charset=UTF-8",
          "X-API-KEY": this.config.key,
          "X-API-SIGN": createHmac("sha256", this.config.secret).update(body).digest("hex"),
        },
        body,
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new FixedFloatError(false);
    }
    if (!response.ok) throw new FixedFloatError(false);
    let result;
    try {
      result = z
        .object({ code: z.number(), data: z.unknown().optional() })
        .parse(await response.json());
    } catch {
      throw new FixedFloatError(false);
    }
    if (result.code !== 0) throw new FixedFloatError(true);
    return result.data;
  }
  async getQuote(sats: string): Promise<FixedFloatQuote> {
    const currencies = z.array(currency).parse(await this.call("ccies", {}));
    if (
      !currencies.some((c) => c.code === "BTCLN" && c.coin === "BTC" && c.recv) ||
      !currencies.some((c) => c.code === "SOL" && c.coin === "SOL" && c.send)
    )
      throw new Error("Lightning deposits are temporarily unavailable.");
    const result = quote.parse(
      await this.call("price", {
        fromCcy: "BTCLN",
        toCcy: "SOL",
        amount: satsToBtc(sats),
        direction: "from",
        type: "float",
        refcode: this.config.refcode,
        afftax: 0.5,
      }),
    );
    if (result.from.code !== "BTCLN" || result.to.code !== "SOL" || result.errors.length)
      throw new Error(
        `Amount unavailable. FixedFloat currently accepts ${result.from.min}–${result.from.max} BTC for this route.`,
      );
    return result;
  }
  async create(sats: string, destination: string): Promise<FixedFloatOrder> {
    const result = await this.call(
      "create",
      {
        fromCcy: "BTCLN",
        toCcy: "SOL",
        amount: satsToBtc(sats),
        direction: "from",
        type: "float",
        refcode: this.config.refcode,
        afftax: 0.5,
        toAddress: destination,
      },
      50,
    );
    // A malformed successful response is ambiguous: never retry creation automatically.
    try {
      return OrderSchema.extend({ token: z.string().min(1) }).parse(result);
    } catch {
      throw new FixedFloatError(false);
    }
  }
  async order(id: string, token: string): Promise<FixedFloatOrder> {
    return OrderSchema.parse(await this.call("order", { id, token }));
  }
}
