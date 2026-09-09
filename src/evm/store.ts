import { Database } from "bun:sqlite";
import { chmodSync } from "node:fs";
import type { Hex } from "viem";

export interface EvmAction {
  id: string;
  user: string;
  chat: number;
  message: number;
  kind: "create" | "join" | "refund" | "close" | "withdraw";
  body: string;
  phase: "proposal" | "new" | "approval" | "transaction" | "done" | "failed";
  raw: Hex | null;
  hash: Hex | null;
}
export interface GameMessage {
  game: Hex;
  chat: number;
  message: number;
  body: string;
  creator: string;
}
export class EvmBotStore {
  readonly db: Database;
  constructor(path: string, identity: string) {
    this.db = new Database(path, { create: true, strict: true });
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS command_networks (id TEXT PRIMARY KEY, chain TEXT NOT NULL CHECK(chain IN ('solana','evm')));
      CREATE TABLE IF NOT EXISTS network_tokens (chat TEXT PRIMARY KEY, token TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS network_preferences (chat TEXT PRIMARY KEY, chain TEXT NOT NULL CHECK(chain IN ('solana','evm')));
      CREATE TABLE IF NOT EXISTS identity (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS actions (id TEXT PRIMARY KEY,user TEXT NOT NULL,chat INTEGER NOT NULL,message INTEGER NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL,phase TEXT NOT NULL,raw TEXT,hash TEXT,notified INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS invitations (game TEXT NOT NULL,user TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(game,user));
      CREATE TABLE IF NOT EXISTS game_messages (game TEXT NOT NULL,chat INTEGER NOT NULL,message INTEGER NOT NULL,body TEXT NOT NULL,creator TEXT NOT NULL,next_check INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(game,chat,message));`);
    this.db.query("INSERT OR IGNORE INTO identity VALUES (1,?)").run(identity);
    if (
      this.db.query<{ value: string }, []>("SELECT value FROM identity").get()?.value !== identity
    ) {
      this.db.close();
      throw new Error("EVM bot database deployment mismatch");
    }
  }
  commandNetwork(id: string, chat: string, selected?: "solana" | "evm"): "solana" | "evm" {
    // Pin the first route before any signing, including Solana commands. Replays
    // retain that route even if an administrator changed the chat preference.
    this.db
      .query("INSERT OR IGNORE INTO command_networks VALUES (?,?)")
      .run(id, this.action(id) ? "evm" : (selected ?? this.network(chat)));
    return this.db
      .query<{ chain: "solana" | "evm" }, [string]>("SELECT chain FROM command_networks WHERE id=?")
      .get(id)!.chain;
  }
  token(chat: string): string | undefined {
    return this.db
      .query<{ token: string }, [string]>("SELECT token FROM network_tokens WHERE chat=?")
      .get(chat)?.token;
  }
  setToken(chat: string, token: string) {
    this.db
      .query(
        "INSERT INTO network_tokens VALUES (?,?) ON CONFLICT(chat) DO UPDATE SET token=excluded.token",
      )
      .run(chat, token);
  }
  network(chat: string): "solana" | "evm" {
    return (
      this.db
        .query<{ chain: "solana" | "evm" }, [string]>(
          "SELECT chain FROM network_preferences WHERE chat=?",
        )
        .get(chat)?.chain ?? "solana"
    );
  }
  setNetwork(chat: string, chain: "solana" | "evm") {
    this.db
      .query(
        "INSERT INTO network_preferences VALUES (?,?) ON CONFLICT(chat) DO UPDATE SET chain=excluded.chain",
      )
      .run(chat, chain);
  }
  action(id: string) {
    return this.db.query<EvmAction, [string]>("SELECT * FROM actions WHERE id=?").get(id);
  }
  pending() {
    return this.db
      .query<EvmAction, []>(
        "SELECT * FROM actions WHERE phase IN ('new','approval','transaction') ORDER BY rowid",
      )
      .all();
  }
  add(action: EvmAction) {
    if (this.pending().some((row) => row.user === action.user))
      throw new Error("This wallet has a transaction awaiting confirmation");
    this.db
      .query(
        "INSERT INTO actions (id,user,chat,message,kind,body,phase,raw,hash) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run(
        action.id,
        action.user,
        action.chat,
        action.message,
        action.kind,
        action.body,
        action.phase,
        action.raw,
        action.hash,
      );
  }
  update(action: EvmAction) {
    this.db
      .query("UPDATE actions SET body=?,phase=?,raw=?,hash=? WHERE id=?")
      .run(action.body, action.phase, action.raw, action.hash, action.id);
  }
  invite(game: Hex, user: string, body: string) {
    this.db
      .query(
        "INSERT INTO invitations VALUES (?,?,?) ON CONFLICT(game,user) DO UPDATE SET body=excluded.body",
      )
      .run(game, user, body);
  }
  invitation(game: Hex, user: string) {
    return this.db
      .query<{ body: string }, [string, string]>(
        "SELECT body FROM invitations WHERE game=? AND user=?",
      )
      .get(game, user);
  }
  finish(action: EvmAction) {
    this.db.transaction(() => {
      this.update(action);
      if (action.phase === "done" && action.kind === "create") {
        const body = JSON.parse(action.body) as { game: Hex };
        this.message({
          game: body.game,
          chat: action.chat,
          message: action.message,
          body: "",
          creator: action.user,
        });
      }
    })();
  }
  unnotified() {
    return this.db
      .query<EvmAction, []>("SELECT * FROM actions WHERE phase IN ('done','failed') AND notified=0")
      .all();
  }
  notified(id: string) {
    this.db.query("UPDATE actions SET notified=1 WHERE id=?").run(id);
  }
  messages() {
    return this.db
      .query<GameMessage, [number]>(
        "SELECT * FROM game_messages WHERE next_check<=? ORDER BY next_check LIMIT 100",
      )
      .all(Date.now());
  }
  deferMessage(row: GameMessage, milliseconds: number) {
    this.db
      .query("UPDATE game_messages SET next_check=? WHERE game=? AND chat=? AND message=?")
      .run(Date.now() + milliseconds, row.game, row.chat, row.message);
  }
  message(row: GameMessage) {
    this.db
      .query(
        "INSERT INTO game_messages (game,chat,message,body,creator) VALUES (?,?,?,?,?) ON CONFLICT(game,chat,message) DO UPDATE SET body=excluded.body",
      )
      .run(row.game, row.chat, row.message, row.body, row.creator);
  }
  close() {
    this.db.close();
  }
}
export const json = (value: unknown) =>
  JSON.stringify(value, (_, item: unknown) => (typeof item === "bigint" ? item.toString() : item));
