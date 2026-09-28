import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Connection, Keypair } from "../src/utils/solana";
import { createProgramContext, loadProgramContext } from "../src/utils/program-context";
import { WalletManager } from "../src/utils/wallet";

const originalNetwork = process.env.SOLANA_NETWORK;
const originalMnemonic = process.env.MNEMONIC;
const originalMnemonicFile = process.env.MNEMONIC_FILE;

beforeEach(() => {
  delete process.env.MNEMONIC_FILE;
});

afterEach(() => {
  process.env.SOLANA_NETWORK = originalNetwork;
  process.env.MNEMONIC = originalMnemonic;
  if (originalMnemonicFile === undefined) delete process.env.MNEMONIC_FILE;
  else process.env.MNEMONIC_FILE = originalMnemonicFile;
});

describe("createProgramContext", () => {
  test("reuses a supplied connection for both the provider and the program", () => {
    const connection = new Connection("http://supplied:8899", "processed");

    const context = createProgramContext({ connection, rpcUrl: "http://ignored:1" });

    expect(context.provider.connection).toBe(connection);
    expect(context.program.provider.connection).toBe(connection);
  });

  test("builds a connection from the explicit RPC URL with confirmed commitment by default", () => {
    const context = createProgramContext({ rpcUrl: "http://explicit:8899" });

    expect(context.provider.connection.rpcEndpoint).toBe("http://explicit:8899");
    expect(context.provider.connection.commitment).toBe("confirmed");
  });

  test("honours an explicit commitment", () => {
    const context = createProgramContext({
      rpcUrl: "http://explicit:8899",
      commitment: "finalized",
    });

    expect(context.provider.connection.commitment).toBe("finalized");
  });

  test("uses the connection config instead of the bare commitment when one is supplied", () => {
    const context = createProgramContext({
      rpcUrl: "http://explicit:8899",
      commitment: "finalized",
      connectionConfig: { commitment: "processed" },
    });

    expect(context.provider.connection.commitment).toBe("processed");
  });

  test("takes the first endpoint from SOLANA_NETWORK when no URL is given", () => {
    process.env.SOLANA_NETWORK = "http://first:8899,http://second:8899";

    const context = createProgramContext();

    expect(context.provider.connection.rpcEndpoint).toBe("http://first:8899");
  });

  test("falls back to mainnet-beta when neither a URL nor SOLANA_NETWORK is set", () => {
    Reflect.deleteProperty(process.env, "SOLANA_NETWORK");

    const context = createProgramContext();

    expect(context.provider.connection.rpcEndpoint).toBe("https://api.mainnet-beta.solana.com/");
  });
});

describe("loadProgramContext", () => {
  const makeWallet = async () => {
    const operatorKeypair = await Keypair.generate();
    const walletConnection = new Connection("http://wallet:8899", "confirmed");
    const wallet = {
      getOperatorKeypair: mock(async () => operatorKeypair),
      getConnection: mock(() => walletConnection),
    } as unknown as WalletManager;
    return { wallet, operatorKeypair, walletConnection };
  };

  test("uses the supplied wallet and its connection", async () => {
    const { wallet, operatorKeypair, walletConnection } = await makeWallet();

    const loaded = await loadProgramContext({ wallet });

    expect(loaded.wallet).toBe(wallet);
    expect(loaded.operatorKeypair).toBe(operatorKeypair);
    expect(loaded.connection).toBe(walletConnection);
    expect(loaded.provider.connection).toBe(walletConnection);
    expect(loaded.program.provider.connection).toBe(walletConnection);
  });

  test("prefers an explicit connection over the wallet's", async () => {
    const { wallet } = await makeWallet();
    const explicit = new Connection("http://explicit:8899", "processed");

    const loaded = await loadProgramContext({ wallet, connection: explicit });

    expect(loaded.connection).toBe(explicit);
    expect(wallet.getConnection).not.toHaveBeenCalled();
  });

  describe("without an explicit wallet", () => {
    let operatorKeypair: Keypair;
    let operatorSpy: ReturnType<typeof spyOn>;
    beforeEach(async () => {
      operatorKeypair = await Keypair.generate();
      // The singleton has no operator key file in tests; stub only that lookup.
      operatorSpy = spyOn(WalletManager.prototype, "getOperatorKeypair").mockResolvedValue(
        operatorKeypair,
      );
    });
    afterEach(() => operatorSpy.mockRestore());

    test("derives the wallet from the trimmed mnemonic option", async () => {
      const mnemonic = process.env.MNEMONIC!;

      const loaded = await loadProgramContext({ mnemonic: `  ${mnemonic}  ` });

      const expected = WalletManager.getInstance(mnemonic);
      expect(loaded.wallet).toBe(expected);
      expect(loaded.operatorKeypair).toBe(operatorKeypair);
      expect(loaded.connection).toBe(expected.getConnection());
    });

    test("falls back to the environment mnemonic when the option is blank", async () => {
      const loaded = await loadProgramContext({ mnemonic: "   " });

      expect(loaded.wallet).toBe(WalletManager.getInstance(process.env.MNEMONIC!));
    });
  });

  test("propagates a missing operator key", async () => {
    const { wallet } = await makeWallet();
    (wallet.getOperatorKeypair as any).mockImplementation(async () => {
      throw new Error("Operator keypair file not found at /nowhere");
    });

    await expect(loadProgramContext({ wallet })).rejects.toThrow("Operator keypair file not found");
  });

  test("rejects when no mnemonic is configured anywhere", async () => {
    delete process.env.MNEMONIC;

    await expect(loadProgramContext()).rejects.toThrow("MNEMONIC_FILE is required");
  });

  test("rejects an invalid environment mnemonic", async () => {
    process.env.MNEMONIC = "not a real mnemonic";

    await expect(loadProgramContext()).rejects.toThrow("not valid BIP-39");
  });
});
