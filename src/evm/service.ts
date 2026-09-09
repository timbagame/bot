import { transactionProgress } from "@timbagame/protocol/games";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  fallback,
  http,
  erc20Abi,
  encodeFunctionData,
  keccak256,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import {
  creationTypedData,
  createGameTransaction,
  joinGameTransaction,
  refundPlayerTransaction,
  closeGameTransaction,
  timbaAbi,
  privateJoinTypedData,
  type CreateGameRequest,
} from "@timbagame/protocol/evm/v0.1.0";
import {
  evmMetadataSchema as metadataSchema,
  checkCreationAuthorization,
} from "@timbagame/protocol/evm";
import { evmAccount } from "./wallet";
import { EvmBotStore, json, type EvmAction } from "./store";
import type { EvmBotConfig } from "./config";

export type { EvmMetadata } from "@timbagame/protocol/evm";
export interface ActionBody {
  game?: Hex;
  token?: Address;
  amount?: string;
  recipient?: Address;
  request?: CreateGameRequest;
  signature?: Hex;
  refundingPlayer?: boolean;
  timeout?: number;
  minPlayers?: number;
  maxPlayers?: number;
  gameType?: 0 | 1;
  isPrivate?: boolean;
  invitation?: { deadline: string; signature: Hex };
  native?: boolean;
  createdAt?: number;
  approvalAmount?: string;
}
export class EvmBotService {
  readonly chain;
  readonly transport;
  readonly client;
  constructor(
    readonly config: EvmBotConfig,
    readonly mnemonic: string,
    readonly apiToken: string,
    readonly store: EvmBotStore,
  ) {
    this.chain = defineChain({
      id: config.chainId,
      name: config.name,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: config.rpcUrls } },
    });
    this.transport = fallback(
      config.rpcUrls.map((url) => http(url, { timeout: 3_000, retryCount: 0 })),
      { rank: false, retryCount: 0 },
    );
    this.client = createPublicClient({ chain: this.chain, transport: this.transport });
  }
  account(user: string) {
    return evmAccount(this.mnemonic, user);
  }
  wallet(user: string) {
    return createWalletClient({
      chain: this.chain,
      transport: this.transport,
      account: this.account(user),
    });
  }
  async oracle(path: string, input?: unknown): Promise<unknown> {
    const response = await fetch(new URL(path, this.config.oracleUrl), {
      method: input === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${this.apiToken}`, "content-type": "application/json" },
      body: input === undefined ? undefined : json(input),
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) throw new Error("EVM oracle request failed");
    return response.json();
  }
  async metadata() {
    const metadata = metadataSchema.parse(await this.oracle("/evm/config"));
    if (metadata.chainId !== this.config.chainId || metadata.address !== this.config.address)
      throw new Error("EVM oracle deployment mismatch");
    if ((await this.client.getChainId()) !== this.config.chainId)
      throw new Error("EVM RPC chain mismatch");
    return metadata;
  }
  async invite(gameId: Hex, creator: string, player: string) {
    const game = await this.game(gameId);
    const account = this.account(creator);
    if (game.creator.toLowerCase() !== account.address.toLowerCase())
      throw new Error("Only the creator can invite");
    const deadline = (await this.client.getBlock()).timestamp + 300n;
    const target = this.account(player).address;
    const proof = await account.signTypedData(
      privateJoinTypedData(this.config, gameId, target, deadline),
    );
    return (await this.oracle("/evm/private-join", {
      gameId,
      player: target,
      deadline,
      proof,
    })) as { deadline: string; signature: Hex };
  }
  game(id: Hex) {
    return this.client.readContract({
      address: this.config.address,
      abi: timbaAbi,
      functionName: "getGame",
      args: [id],
    });
  }
  async step(action: EvmAction) {
    const wallet = this.wallet(action.user);
    const body = JSON.parse(action.body) as ActionBody;
    if (action.raw && action.hash) {
      const receipt = await this.client
        .getTransactionReceipt({ hash: action.hash })
        .catch((error) => {
          if (error?.name === "TransactionReceiptNotFoundError") return null;
          throw error;
        });
      if (!receipt) {
        await this.client
          .sendRawTransaction({ serializedTransaction: action.raw })
          .catch(() => undefined);
        return;
      }
      const progress = transactionProgress(
        {
          success: receipt.status === "success",
          confirmations: Number(
            (await this.client.getBlockNumber({ cacheTime: 0 })) - receipt.blockNumber + 1n,
          ),
        },
        this.config.confirmations,
      );
      if (progress === "submitted") return;
      if (progress === "failed") {
        action.phase = "failed";
        this.store.update(action);
        return;
      }
      if (action.phase === "approval") {
        if (!body.token || body.approvalAmount === undefined)
          throw new Error("Missing durable approval context");
        const approved = await this.client.readContract({
          address: body.token,
          abi: erc20Abi,
          functionName: "allowance",
          args: [wallet.account.address, this.config.address],
        });
        if (approved < BigInt(body.approvalAmount)) {
          action.phase = "failed";
          this.store.update(action);
          return;
        }
        action.phase = "new";
        action.raw = null;
        action.hash = null;
        this.store.update(action);
        return;
      }
      if (action.kind === "close" && body.refundingPlayer) {
        delete body.refundingPlayer;
        action.body = json(body);
        action.phase = "new";
        action.raw = null;
        action.hash = null;
        this.store.update(action);
        return;
      }
      action.phase = "done";
      this.store.finish(action);
      return;
    }
    let tx: { to: Address; data: Hex; value?: bigint };
    let spend = 0n;
    if (action.kind === "create") {
      if (!body.token || !body.amount) throw new Error("Missing game stake");
      if (!body.request) {
        const nonce = await this.client.readContract({
          address: this.config.address,
          abi: timbaAbi,
          functionName: "creationNonces",
          args: [wallet.account.address],
        });
        const deadline = (await this.client.getBlock()).timestamp + 300n;
        const request: CreateGameRequest = {
          creator: wallet.account.address,
          token: body.token,
          gameType: body.gameType ?? 0,
          amount: BigInt(body.amount),
          minPlayers: body.minPlayers ?? 2,
          maxPlayers: body.maxPlayers ?? 2,
          timeout: body.timeout ?? 3600,
          isPrivate: body.isPrivate ?? false,
          nonce,
          deadline,
          commitment: zeroHash,
        };
        const proof = await wallet.signTypedData(creationTypedData(this.config, request));
        const result = checkCreationAuthorization(
          this.config,
          request,
          await this.oracle("/evm/authorize", { ...request, commitment: undefined, proof }),
        );
        const authorized = result.request;
        const operator = await this.client.readContract({
          address: this.config.address,
          abi: timbaAbi,
          functionName: "owner",
        });
        if (
          !(await this.client.verifyTypedData({
            address: operator,
            ...creationTypedData(this.config, authorized),
            signature: result.signature,
          }))
        )
          throw new Error("Invalid oracle authorization");
        body.request = authorized;
        body.signature = result.signature;
        body.game = result.gameId;
        action.body = json(body);
        this.store.update(action);
      }
      const request = {
        ...body.request,
        amount: BigInt(body.request.amount),
        nonce: BigInt(body.request.nonce),
        deadline: BigInt(body.request.deadline),
      };
      // Renew an expired authorization with the same nonce and economic terms, never a new game.
      if (request.deadline <= (await this.client.getBlock()).timestamp) {
        delete body.request;
        delete body.signature;
        action.body = json(body);
        this.store.update(action);
        return;
      }
      spend = request.amount;
      tx = createGameTransaction(this.config, request, body.signature!, request.gameType === 0);
    } else if (action.kind === "withdraw") {
      if (!body.amount || !body.recipient || (!body.native && !body.token))
        throw new Error("Invalid withdrawal");
      tx = body.native
        ? { to: body.recipient, data: "0x", value: BigInt(body.amount) }
        : {
            to: body.token!,
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: "transfer",
              args: [body.recipient, BigInt(body.amount)],
            }),
          };
    } else {
      if (!body.game) throw new Error("Missing game");
      if (action.kind === "join") {
        const game = await this.game(body.game);
        body.token = game.token;
        spend = game.gameType === 0 ? game.ticketAmount : 0n;
        tx = joinGameTransaction(
          this.config,
          body.game,
          body.invitation
            ? { deadline: BigInt(body.invitation.deadline), signature: body.invitation.signature }
            : undefined,
        );
      } else if (action.kind === "refund")
        tx = refundPlayerTransaction(this.config, body.game, wallet.account.address);
      else {
        const game = await this.game(body.game);
        if (game.status === 2 || game.status === 3) {
          action.phase = "done";
          this.store.finish(action);
          return;
        }
        const player = game.gameType === 0 ? game.participants[0] : undefined;
        body.refundingPlayer = Boolean(player);
        tx = player
          ? refundPlayerTransaction(this.config, body.game, player)
          : closeGameTransaction(this.config, body.game);
      }
    }
    if (spend > 0n && body.token) {
      const allowance = await this.client.readContract({
        address: body.token,
        abi: erc20Abi,
        functionName: "allowance",
        args: [wallet.account.address, this.config.address],
      });
      if (allowance < spend) {
        // Reset nonzero allowances first for tokens that require it; never grant unlimited approval.
        tx = {
          to: body.token,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "approve",
            args: [this.config.address, allowance === 0n ? spend : 0n],
          }),
        };
        action.phase = "approval";
        body.approvalAmount = (allowance === 0n ? spend : 0n).toString();
      } else action.phase = "transaction";
    } else action.phase = "transaction";
    const prepared = await wallet.prepareTransactionRequest({ ...tx, account: wallet.account });
    const raw = await wallet.signTransaction(prepared);
    action.raw = raw;
    action.hash = keccak256(raw);
    action.body = json(body);
    this.store.update(action); // durable before first broadcast
    await this.client.sendRawTransaction({ serializedTransaction: raw });
  }
}
