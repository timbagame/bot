import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";

type BNLike = InstanceType<typeof BN>;

export type OracleConfig = {
  feePercentage: number;
  oracleBufferTime: BNLike;
  maxTickets: number;
  maxTimeout: BNLike;
  minTimeout: BNLike;
};

type OracleConfigOverrides = {
  feePercentage?: number;
  oracleBufferTime?: BNLike | bigint | number;
  maxTickets?: number;
  maxTimeout?: BNLike | bigint | number;
  minTimeout?: BNLike | bigint | number;
};

const DEFAULT_ORACLE_CONFIG: OracleConfig = {
  feePercentage: 1,
  oracleBufferTime: new anchor.BN(3600),
  maxTickets: 100,
  maxTimeout: new anchor.BN(86400),
  minTimeout: new anchor.BN(300),
};

const toBN = (value: BNLike | bigint | number | undefined): BNLike => {
  if (value === undefined) {
    throw new Error("BN conversion requires a defined value");
  }

  if (value instanceof anchor.BN) {
    return value;
  }

  if (BN.isBN(value)) {
    return new anchor.BN(value) as BNLike;
  }

  if (typeof value === "bigint") {
    return new anchor.BN(value.toString()) as BNLike;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Cannot convert non-finite number to BN");
    }
    return new anchor.BN(Math.trunc(value)) as BNLike;
  }

  throw new Error(`Unsupported BN conversion type: ${typeof value}`);
};

export const createOracleConfig = (
  overrides: OracleConfigOverrides = {}
): OracleConfig => {
  return {
    feePercentage: overrides.feePercentage ?? DEFAULT_ORACLE_CONFIG.feePercentage,
    oracleBufferTime: overrides.oracleBufferTime
      ? toBN(overrides.oracleBufferTime)
      : DEFAULT_ORACLE_CONFIG.oracleBufferTime,
    maxTickets: overrides.maxTickets ?? DEFAULT_ORACLE_CONFIG.maxTickets,
    maxTimeout: overrides.maxTimeout
      ? toBN(overrides.maxTimeout)
      : DEFAULT_ORACLE_CONFIG.maxTimeout,
    minTimeout: overrides.minTimeout
      ? toBN(overrides.minTimeout)
      : DEFAULT_ORACLE_CONFIG.minTimeout,
  };
};

type LogOptions = {
  heading?: string;
  indent?: string;
};

const secondsToMinutes = (value: BNLike): number => {
  try {
    return Math.round(value.toNumber() / 60);
  } catch (_error) {
    return 0;
  }
};

export const logOracleConfig = (
  config: OracleConfig,
  options: LogOptions = {}
): void => {
  const heading = options.heading ?? "Oracle configuration";
  const indent = options.indent ?? "-";

  const bufferSeconds = config.oracleBufferTime.toNumber();
  const maxTimeoutSeconds = config.maxTimeout.toNumber();
  const minTimeoutSeconds = config.minTimeout.toNumber();

  console.log(`\n${heading}:`);
  console.log(`${indent} Fee Percentage: ${config.feePercentage}%`);
  console.log(
    `${indent} Min Timeout: ${minTimeoutSeconds} seconds (${secondsToMinutes(
      config.minTimeout
    )} minutes)`
  );
  console.log(
    `${indent} Max Timeout: ${maxTimeoutSeconds} seconds (${secondsToMinutes(
      config.maxTimeout
    )} minutes)`
  );
  console.log(`${indent} Max Tickets: ${config.maxTickets}`);
  console.log(`${indent} Oracle Buffer Time: ${bufferSeconds} seconds`);
};
