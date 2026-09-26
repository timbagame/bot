import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  decodeFunctionData,
  erc20Abi,
  keccak256,
  parseTransaction,
  verifyTypedData,
  type Address,
  type Hex,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { creationTypedData, gameIdFor, timbaAbi } from "@timbagame/protocol/evm/v0.1.0";
import { EvmBotService } from "./service";
import { EvmBotStore, json, type EvmAction } from "./store";
import { evmBotConfigSchema } from "./config";

const mnemonic = "test test test test test test test test test test test junk";
const operator = mnemonicToAccount(mnemonic, { path: "m/44'/60'/0'/0/7" });
const config = evmBotConfigSchema.parse({
  chainId: 31337,
  address: `0x${"11".repeat(20)}`,
  version: "0.1.0",
  name: "Anvil",
  rpcUrls: ["http://127.0.0.1:1"],
  oracleUrl: "http://oracle.test",
  oracleTokenFile: "/dev/null",
  database: ":memory:",
  webUrl: "http://localhost",
  confirmations: 2,
});
const token = `0x${"22".repeat(20)}` as Address;
const gameId = `0x${"33".repeat(32)}` as Hex;
const commitment = `0x${"44".repeat(32)}` as Hex;

type OracleCall = { url: string; method: string; body: any; auth: string | null };

let store: EvmBotStore;
let service: EvmBotService;
let sent: Hex[];
let oracleCalls: OracleCall[];
let oracleHandler: (path: string, body: any) => { status?: number; body: unknown };
type ReadName = "getGame" | "creationNonces" | "owner" | "allowance";
let reads: Partial<Record<ReadName, (args: any) => unknown>>;
let receipt: unknown;
let receiptError: unknown;
let blockNumber: bigint;
let blockTimestamp: bigint;
let chainId: number;
const originalFetch = globalThis.fetch;

const action = (overrides: Partial<EvmAction> = {}): EvmAction => ({
  id: overrides.id ?? crypto.randomUUID(),
  user: "101",
  chat: -100,
  message: 7,
  kind: "join",
  body: "{}",
  phase: "new",
  raw: null,
  hash: null,
  ...overrides,
});

const addAction = (overrides: Partial<EvmAction> = {}) => {
  const created = action(overrides);
  store.add(created);
  return created;
};

const stored = (id: string) => store.action(id)!;
const lastSentCall = () => {
  const raw = sent.at(-1)!;
  const tx = parseTransaction(raw);
  return { raw, tx };
};

beforeEach(() => {
  store = new EvmBotStore(":memory:", "test");
  service = new EvmBotService(config, mnemonic, "api-token", store);
  sent = [];
  oracleCalls = [];
  oracleHandler = () => ({ body: {} });
  receipt = null;
  receiptError = undefined;
  blockNumber = 100n;
  blockTimestamp = 1_000n;
  chainId = 31337;
  reads = {};

  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    oracleCalls.push({
      url: url.toString(),
      method: init?.method ?? "GET",
      body,
      auth: new Headers(init?.headers).get("authorization"),
    });
    const result = oracleHandler(url.pathname, body);
    return new Response(JSON.stringify(result.body), { status: result.status ?? 200 });
  }) as typeof fetch;

  (service as any).client = {
    getChainId: async () => chainId,
    getBlock: async () => ({ timestamp: blockTimestamp }),
    getBlockNumber: async () => blockNumber,
    readContract: async (args: any) => {
      const handler = reads[args.functionName as ReadName];
      if (!handler) throw new Error(`unexpected read ${args.functionName}`);
      return handler(args);
    },
    getTransactionReceipt: async () => {
      if (receiptError) throw receiptError;
      if (!receipt) {
        throw Object.assign(new Error("not found"), { name: "TransactionReceiptNotFoundError" });
      }
      return receipt;
    },
    sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
      sent.push(serializedTransaction);
      return keccak256(serializedTransaction);
    },
    verifyTypedData: (args: any) => verifyTypedData(args),
  };
  service.wallet = ((user: string) => {
    const account = service.account(user);
    return {
      account,
      signTypedData: (data: any) => account.signTypedData(data),
      prepareTransactionRequest: async (tx: any) => ({
        ...tx,
        chainId: config.chainId,
        nonce: 0,
        gas: 100_000n,
        maxFeePerGas: 2n,
        maxPriorityFeePerGas: 1n,
        type: "eip1559",
      }),
      signTransaction: (prepared: any) => {
        const { account: _ignored, ...request } = prepared;
        return account.signTransaction(request);
      },
    };
  }) as any;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  store.close();
});

describe("EvmBotService oracle and metadata", () => {
  test("oracle sends authenticated GET and POST requests and rejects failures", async () => {
    oracleHandler = (path) => ({ body: { path } });
    expect(await service.oracle("/evm/config")).toEqual({ path: "/evm/config" });
    expect(await service.oracle("/evm/authorize", { value: 1n })).toEqual({
      path: "/evm/authorize",
    });
    expect(oracleCalls.map(({ method, auth }) => [method, auth])).toEqual([
      ["GET", "Bearer api-token"],
      ["POST", "Bearer api-token"],
    ]);
    expect(oracleCalls[1]!.body).toEqual({ value: "1" });

    oracleHandler = () => ({ status: 500, body: {} });
    await expect(service.oracle("/evm/config")).rejects.toThrow("EVM oracle request failed");
  });

  test("metadata requires the oracle deployment and RPC chain to match the config", async () => {
    const metadata = {
      chainId: config.chainId,
      address: config.address,
      version: "0.1.0",
      confirmations: 2,
      tokens: [{ address: token, symbol: "TEST", decimals: 18, minimumAmount: "1" }],
    };
    oracleHandler = () => ({ body: metadata });
    expect(await service.metadata()).toMatchObject({ chainId: 31337, address: config.address });

    chainId = 1;
    await expect(service.metadata()).rejects.toThrow("EVM RPC chain mismatch");

    oracleHandler = () => ({ body: { ...metadata, chainId: 8453 } });
    await expect(service.metadata()).rejects.toThrow("EVM oracle deployment mismatch");
  });

  test("wallet clients sign with the user's derived account on the configured chain", () => {
    const wallet = EvmBotService.prototype.wallet.call(service, "101");
    expect(wallet.account.address).toBe(service.account("101").address);
    expect(wallet.chain.id).toBe(config.chainId);
  });

  test("game reads the on-chain game by id", async () => {
    reads.getGame = ({ args, address }) => ({ id: args[0], address });
    expect(await service.game(gameId)).toEqual({ id: gameId, address: config.address } as any);
  });

  test("invite signs a private join proof only for the game creator", async () => {
    const creator = service.account("101");
    reads.getGame = () => ({ creator: creator.address });
    oracleHandler = (_path, body) => ({ body: { deadline: body.deadline, signature: "0x1234" } });

    const invitation = await service.invite(gameId, "101", "202");
    expect(invitation).toEqual({ deadline: "1300", signature: "0x1234" } as any);
    const call = oracleCalls.at(-1)!;
    expect(new URL(call.url).pathname).toBe("/evm/private-join");
    expect(call.body.player).toBe(service.account("202").address);
    expect(call.body.proof).toMatch(/^0x[0-9a-f]+$/);

    await expect(service.invite(gameId, "303", "202")).rejects.toThrow(
      "Only the creator can invite",
    );
  });
});

describe("EvmBotService.step for new actions", () => {
  const authorize = (options: { signer?: typeof operator; changeAmount?: boolean } = {}) => {
    oracleHandler = (path, body) => {
      if (path !== "/evm/authorize") throw new Error(path);
      const request = {
        creator: body.creator,
        token: body.token,
        gameType: body.gameType,
        amount: options.changeAmount ? "999" : body.amount,
        minPlayers: body.minPlayers,
        maxPlayers: body.maxPlayers,
        timeout: body.timeout,
        isPrivate: body.isPrivate,
        nonce: body.nonce,
        deadline: body.deadline,
        commitment,
      };
      return {
        body: {
          gameId: gameIdFor(config, body.creator, BigInt(body.nonce)),
          request,
          signature: "0x00",
        },
      };
    };
  };

  test("create obtains an oracle authorization, then asks for token approval", async () => {
    authorize();
    reads.creationNonces = () => 5n;
    reads.owner = () => operator.address;
    reads.allowance = () => 0n;
    (service as any).client.verifyTypedData = async (args: any) => {
      expect(args.address).toBe(operator.address);
      expect(args.message.commitment).toBe(commitment);
      return true;
    };

    const created = addAction({
      kind: "create",
      body: json({ token, amount: "1000", gameType: 1, maxPlayers: 5, isPrivate: true }),
    });
    await service.step(created);

    const row = stored(created.id);
    expect(row.phase).toBe("approval");
    const body = JSON.parse(row.body);
    expect(body.game).toBe(gameIdFor(config, service.account("101").address, 5n));
    expect(body.request).toMatchObject({ amount: "1000", maxPlayers: 5, isPrivate: true });
    expect(body.approvalAmount).toBe("1000");
    expect(row.hash).toBe(keccak256(row.raw!));
    const { tx } = lastSentCall();
    expect(tx.to).toBe(token);
    const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data! });
    expect(decoded.functionName).toBe("approve");
    expect(decoded.args).toEqual([config.address, 1000n]);
    const authorizeCall = oracleCalls.find((call) => call.url.endsWith("/evm/authorize"))!;
    expect(authorizeCall.body.commitment).toBeUndefined();
  });

  test("create accepts a real operator signature and sends the game transaction", async () => {
    reads.creationNonces = () => 0n;
    reads.owner = () => operator.address;
    reads.allowance = () => 10n ** 18n;
    // The oracle echoes the terms; the operator signs the exact normalized request.
    const account = service.account("101");
    oracleHandler = (_path, body) => ({
      body: {
        gameId: gameIdFor(config, account.address, BigInt(body.nonce)),
        request: { ...body, proof: undefined, commitment },
        signature: "0x00",
      },
    });
    const realOracle = service.oracle.bind(service);
    service.oracle = async (path: string, input?: unknown) => {
      const response = (await realOracle(path, input)) as any;
      const request = {
        ...response.request,
        amount: BigInt(response.request.amount),
        nonce: BigInt(response.request.nonce),
        deadline: BigInt(response.request.deadline),
      };
      delete request.proof;
      response.signature = await operator.signTypedData(creationTypedData(config, request));
      delete response.request.proof;
      return response;
    };

    const created = addAction({ kind: "create", body: json({ token, amount: "250" }) });
    await service.step(created);

    const row = stored(created.id);
    expect(row.phase).toBe("transaction");
    const { tx } = lastSentCall();
    expect(tx.to).toBe(config.address);
    const decoded = decodeFunctionData({ abi: timbaAbi, data: tx.data! });
    expect(decoded.functionName).toBe("createGame");
    expect(decoded.args?.[2]).toBe(true);
  });

  test("create rejects authorizations that are not signed by the contract owner", async () => {
    authorize();
    reads.creationNonces = () => 1n;
    reads.owner = () => operator.address;
    (service as any).client.verifyTypedData = async () => false;
    const created = addAction({ kind: "create", body: json({ token, amount: "10" }) });
    await expect(service.step(created)).rejects.toThrow("Invalid oracle authorization");
    expect(sent).toHaveLength(0);
  });

  test("create rejects oracle responses that change the game terms", async () => {
    authorize({ changeAmount: true });
    reads.creationNonces = () => 1n;
    const created = addAction({ kind: "create", body: json({ token, amount: "10" }) });
    await expect(service.step(created)).rejects.toThrow("Oracle changed game terms");
  });

  test("create drops an expired authorization so it can be renewed with the same terms", async () => {
    const created = addAction({
      kind: "create",
      body: json({
        token,
        amount: "10",
        request: { amount: "10", nonce: "1", deadline: "999", gameType: 0 },
        signature: "0x12",
      }),
    });
    await service.step(created);
    const body = JSON.parse(stored(created.id).body);
    expect(body.request).toBeUndefined();
    expect(body.signature).toBeUndefined();
    expect(sent).toHaveLength(0);
  });

  test("create without a stake is rejected", async () => {
    const created = addAction({ kind: "create", body: json({ token }) });
    await expect(service.step(created)).rejects.toThrow("Missing game stake");
  });

  test("withdraw builds native and ERC-20 transfers and validates input", async () => {
    const recipient = `0x${"55".repeat(20)}` as Address;
    const native = addAction({
      kind: "withdraw",
      body: json({ amount: "77", recipient, native: true }),
    });
    await service.step(native);
    expect(lastSentCall().tx).toMatchObject({ to: recipient, value: 77n });
    expect(stored(native.id).phase).toBe("transaction");

    const erc20 = addAction({
      user: "102",
      kind: "withdraw",
      body: json({ amount: "88", recipient, token }),
    });
    await service.step(erc20);
    const { tx } = lastSentCall();
    expect(tx.to).toBe(token);
    expect(decodeFunctionData({ abi: erc20Abi, data: tx.data! }).args).toEqual([recipient, 88n]);

    const invalid = addAction({ user: "103", kind: "withdraw", body: json({ amount: "1" }) });
    await expect(service.step(invalid)).rejects.toThrow("Invalid withdrawal");
  });

  test("join pays the ticket, reusing a sufficient allowance and forwarding invitations", async () => {
    reads.getGame = () => ({ token, gameType: 0, ticketAmount: 40n });
    reads.allowance = () => 40n;
    const joined = addAction({
      kind: "join",
      body: json({ game: gameId, invitation: { deadline: "1300", signature: "0xabcd" } }),
    });
    await service.step(joined);
    const row = stored(joined.id);
    expect(row.phase).toBe("transaction");
    expect(JSON.parse(row.body).token).toBe(token);
    const decoded = decodeFunctionData({ abi: timbaAbi, data: lastSentCall().tx.data! });
    expect(decoded.functionName).toBe("joinGame");
  });

  test("join resets a nonzero but insufficient allowance before approving", async () => {
    reads.getGame = () => ({ token, gameType: 0, ticketAmount: 40n });
    reads.allowance = () => 5n;
    const joined = addAction({ kind: "join", body: json({ game: gameId }) });
    await service.step(joined);
    const row = stored(joined.id);
    expect(row.phase).toBe("approval");
    expect(JSON.parse(row.body).approvalAmount).toBe("0");
    expect(decodeFunctionData({ abi: erc20Abi, data: lastSentCall().tx.data! }).args).toEqual([
      config.address,
      0n,
    ]);
  });

  test("free giveaway joins skip the allowance check", async () => {
    reads.getGame = () => ({ token, gameType: 1, ticketAmount: 40n });
    const joined = addAction({ kind: "join", body: json({ game: gameId }) });
    await service.step(joined);
    expect(stored(joined.id).phase).toBe("transaction");
  });

  test("refund and close build the matching game transactions", async () => {
    const refund = addAction({ kind: "refund", body: json({ game: gameId }) });
    await service.step(refund);
    expect(decodeFunctionData({ abi: timbaAbi, data: lastSentCall().tx.data! }).functionName).toBe(
      "refundPlayer",
    );

    const player = `0x${"66".repeat(20)}` as Address;
    reads.getGame = () => ({ status: 0, gameType: 0, participants: [player] });
    const closeWithPlayer = addAction({
      user: "102",
      kind: "close",
      body: json({ game: gameId }),
    });
    await service.step(closeWithPlayer);
    const decoded = decodeFunctionData({ abi: timbaAbi, data: lastSentCall().tx.data! });
    expect(decoded.functionName).toBe("refundPlayer");
    expect(decoded.args?.[1]).toBe(player);
    expect(JSON.parse(stored(closeWithPlayer.id).body).refundingPlayer).toBe(true);

    reads.getGame = () => ({ status: 0, gameType: 1, participants: [] });
    const close = addAction({ user: "103", kind: "close", body: json({ game: gameId }) });
    await service.step(close);
    expect(decodeFunctionData({ abi: timbaAbi, data: lastSentCall().tx.data! }).functionName).toBe(
      "closeGame",
    );
  });

  test("closing an already finished game completes without a transaction", async () => {
    reads.getGame = () => ({ status: 3, gameType: 1, participants: [] });
    const close = addAction({ kind: "close", body: json({ game: gameId }) });
    await service.step(close);
    expect(stored(close.id).phase).toBe("done");
    expect(sent).toHaveLength(0);
  });

  test("game actions without a game id are rejected", async () => {
    const join = addAction({ kind: "join", body: "{}" });
    await expect(service.step(join)).rejects.toThrow("Missing game");
  });
});

describe("EvmBotService.step for submitted transactions", () => {
  const raw =
    "0x02f86a827a6980018203e8830186a09411111111111111111111111111111111111111118080c0" as Hex;
  const hash = keccak256(raw);
  const submitted = (overrides: Partial<EvmAction> = {}) =>
    addAction({ raw, hash, phase: "transaction", ...overrides });

  test("rebroadcasts transactions that have no receipt yet", async () => {
    const pending = submitted();
    await service.step(pending);
    expect(sent).toEqual([raw]);
    expect(stored(pending.id).phase).toBe("transaction");

    (service as any).client.sendRawTransaction = async () => {
      throw new Error("already known");
    };
    await expect(service.step(pending)).resolves.toBeUndefined();
  });

  test("propagates unexpected receipt lookup errors", async () => {
    receiptError = new Error("rpc down");
    await expect(service.step(submitted())).rejects.toThrow("rpc down");
  });

  test("waits for enough confirmations", async () => {
    receipt = { status: "success", blockNumber: 100n };
    const pending = submitted();
    await service.step(pending);
    expect(stored(pending.id).phase).toBe("transaction");
  });

  test("marks reverted transactions as failed", async () => {
    receipt = { status: "reverted", blockNumber: 90n };
    const pending = submitted();
    await service.step(pending);
    expect(stored(pending.id).phase).toBe("failed");
  });

  test("confirmed approvals restart the action once the allowance is in place", async () => {
    receipt = { status: "success", blockNumber: 90n };
    reads.allowance = () => 50n;
    const approval = submitted({
      phase: "approval",
      body: json({ token, approvalAmount: "50" }),
    });
    await service.step(approval);
    const row = stored(approval.id);
    expect(row).toMatchObject({ phase: "new", raw: null, hash: null });
  });

  test("confirmed approvals fail when the allowance is still too low", async () => {
    receipt = { status: "success", blockNumber: 90n };
    reads.allowance = () => 1n;
    const approval = submitted({
      phase: "approval",
      body: json({ token, approvalAmount: "50" }),
    });
    await service.step(approval);
    expect(stored(approval.id).phase).toBe("failed");
  });

  test("confirmed approvals require their durable context", async () => {
    receipt = { status: "success", blockNumber: 90n };
    const approval = submitted({ phase: "approval", body: json({ token }) });
    await expect(service.step(approval)).rejects.toThrow("Missing durable approval context");
  });

  test("a confirmed refund during close schedules the close itself", async () => {
    receipt = { status: "success", blockNumber: 90n };
    const close = submitted({
      kind: "close",
      body: json({ game: gameId, refundingPlayer: true }),
    });
    await service.step(close);
    const row = stored(close.id);
    expect(row).toMatchObject({ phase: "new", raw: null, hash: null });
    expect(JSON.parse(row.body)).toEqual({ game: gameId });
  });

  test("confirmed creations finish and record the game message", async () => {
    receipt = { status: "success", blockNumber: 90n };
    const created = submitted({ kind: "create", body: json({ game: gameId }) });
    await service.step(created);
    expect(stored(created.id).phase).toBe("done");
    expect(store.messages()).toEqual([
      expect.objectContaining({ game: gameId, chat: -100, message: 7, creator: "101" }),
    ]);
  });
});
