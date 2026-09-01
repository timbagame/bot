import { createDatabaseSingleton, BaseDatabase } from "./base-database";
import type { HoldMarkStore } from "../services/hold-marks";

type HoldMarkRow = {
  mint: string;
  price_usd: number;
};

export class HoldMarksDatabase extends BaseDatabase {
  public static getInstance: () => HoldMarksDatabase;
  public static resetForTesting: () => void;

  static {
    const { getInstance, resetForTesting } = createDatabaseSingleton(() => new HoldMarksDatabase());
    HoldMarksDatabase.getInstance = getInstance;
    HoldMarksDatabase.resetForTesting = resetForTesting;
  }

  private constructor() {
    super(
      "hold-marks.sqlite",
      [
        `CREATE TABLE IF NOT EXISTS hold_marks (
          wallet TEXT NOT NULL,
          mint TEXT NOT NULL,
          price_usd REAL NOT NULL,
          seen_at INTEGER NOT NULL,
          PRIMARY KEY (wallet, mint)
        )`,
      ],
      "HoldMarks",
    );
  }

  getPrice(wallet: string, mint: string): number | undefined {
    const row = this.get<HoldMarkRow>(
      "SELECT mint, price_usd FROM hold_marks WHERE wallet = ? AND mint = ?",
      [wallet, mint],
      "get hold mark",
    );
    if (!row || !(row.price_usd > 0)) {
      return undefined;
    }
    return row.price_usd;
  }

  setPrice(wallet: string, mint: string, priceUsd: number): void {
    if (!(priceUsd > 0) || !Number.isFinite(priceUsd)) {
      return;
    }
    this.run(
      `INSERT OR IGNORE INTO hold_marks (wallet, mint, price_usd, seen_at)
       VALUES (?, ?, ?, ?)`,
      [wallet, mint, priceUsd, Date.now()],
      "set hold mark",
    );
  }

  listMints(wallet: string): string[] {
    const rows = this.all<HoldMarkRow>(
      "SELECT mint, price_usd FROM hold_marks WHERE wallet = ?",
      [wallet],
      "list hold marks",
    );
    return rows.map((row) => row.mint);
  }

  deleteMark(wallet: string, mint: string): void {
    this.run(
      "DELETE FROM hold_marks WHERE wallet = ? AND mint = ?",
      [wallet, mint],
      "delete hold mark",
    );
  }
}

export function createHoldMarksDatabaseStore(): HoldMarkStore {
  return {
    get: (wallet, mint) => HoldMarksDatabase.getInstance().getPrice(wallet, mint),
    set: (wallet, mint, priceUsd) =>
      HoldMarksDatabase.getInstance().setPrice(wallet, mint, priceUsd),
    listMints: (wallet) => HoldMarksDatabase.getInstance().listMints(wallet),
    delete: (wallet, mint) => HoldMarksDatabase.getInstance().deleteMark(wallet, mint),
  };
}
