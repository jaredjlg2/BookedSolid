import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { env } from "../config/env";

export type LevelEstimate = "A0" | "A1" | "A2" | "B1";

export interface CoachUser {
  id: number;
  phone_e164: string;
  name: string | null;
  timezone: string;
  preferred_call_hour_local: number;
  preferred_call_minute_local: number;
  level_estimate: LevelEstimate;
  duolingo_unit: string | null;
  is_active: number;
  consented_at: string | null;
  last_called_at: string | null;
  created_at: string;
  updated_at: string;
}

const nodeRequire = createRequire(__filename);

type Statement = {
  get: (...params: unknown[]) => unknown;
  run: (...params: unknown[]) => unknown;
};

type DatabaseHandle = {
  exec: (sql: string) => void;
  prepare: (sql: string) => Statement;
};

let db: DatabaseHandle | null = null;

function ensureDbPath(dbPath: string) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function getDb(): DatabaseHandle {
  if (!db) {
    const dbPath = env.DB_PATH ?? path.join(process.cwd(), "data", "coach.sqlite");
    ensureDbPath(dbPath);
    db = loadDatabaseDriver().create(dbPath);
    db.exec("PRAGMA journal_mode = WAL;");
    initializeCoachDb(db);
  }
  return db;
}

function loadDatabaseDriver(): { create: (dbPath: string) => DatabaseHandle } {
  try {
    const sqliteModule = nodeRequire("node:sqlite") as {
      DatabaseSync: new (dbPath: string) => DatabaseHandle;
    };
    return { create: (dbPath) => new sqliteModule.DatabaseSync(dbPath) };
  } catch (error) {
    try {
      const BetterSqlite3 = nodeRequire("better-sqlite3") as new (dbPath: string) => DatabaseHandle;
      return { create: (dbPath) => new BetterSqlite3(dbPath) };
    } catch (fallbackError) {
      const reasons = [
        error instanceof Error ? error.message : String(error),
        fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
      ].join(" | ");
      throw new Error(
        `SQLite driver not available. Install "better-sqlite3" or upgrade to Node 22+ to use node:sqlite. (${reasons})`
      );
    }
  }
}

function initializeCoachDb(database: DatabaseHandle) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone_e164 TEXT UNIQUE NOT NULL,
      name TEXT,
      timezone TEXT DEFAULT 'America/Phoenix',
      preferred_call_hour_local INTEGER NOT NULL,
      preferred_call_minute_local INTEGER NOT NULL,
      level_estimate TEXT DEFAULT 'A0',
      duolingo_unit TEXT,
      is_active INTEGER DEFAULT 1,
      consented_at TEXT,
      last_called_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS call_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      call_sid TEXT,
      started_at TEXT,
      ended_at TEXT,
      outcome TEXT,
      summary TEXT,
      metrics_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS vocab_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      word_or_phrase TEXT UNIQUE NOT NULL,
      level_tag TEXT,
      topic_tag TEXT
    );

    CREATE TABLE IF NOT EXISTS user_vocab (
      user_id INTEGER NOT NULL,
      vocab_id INTEGER NOT NULL,
      strength INTEGER DEFAULT 0,
      last_seen_at TEXT,
      PRIMARY KEY(user_id, vocab_id),
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(vocab_id) REFERENCES vocab_items(id)
    );
  `);
}

export function upsertUser(input: {
  phone_e164: string;
  name?: string | null;
  timezone: string;
  preferred_call_hour_local: number;
  preferred_call_minute_local: number;
  duolingo_unit?: string | null;
}): CoachUser {
  const database = getDb();
  const now = new Date().toISOString();

  const existing = database
    .prepare("SELECT * FROM users WHERE phone_e164 = ?")
    .get(input.phone_e164) as CoachUser | undefined;

  if (existing) {
    database
      .prepare(
        `UPDATE users
         SET name = ?, timezone = ?, preferred_call_hour_local = ?, preferred_call_minute_local = ?,
             duolingo_unit = ?, is_active = 1, consented_at = ?, updated_at = ?
         WHERE phone_e164 = ?`
      )
      .run(
        input.name ?? existing.name,
        input.timezone,
        input.preferred_call_hour_local,
        input.preferred_call_minute_local,
        input.duolingo_unit ?? existing.duolingo_unit,
        now,
        now,
        input.phone_e164
      );
  } else {
    database
      .prepare(
        `INSERT INTO users
         (phone_e164, name, timezone, preferred_call_hour_local, preferred_call_minute_local, level_estimate,
          duolingo_unit, is_active, consented_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'A0', ?, 1, ?, ?, ?)`
      )
      .run(
        input.phone_e164,
        input.name ?? null,
        input.timezone,
        input.preferred_call_hour_local,
        input.preferred_call_minute_local,
        input.duolingo_unit ?? null,
        now,
        now,
        now
      );
  }

  return database
    .prepare("SELECT * FROM users WHERE phone_e164 = ?")
    .get(input.phone_e164) as CoachUser;
}

export function setUserInactive(phone: string): void {
  const database = getDb();
  const now = new Date().toISOString();
  database
    .prepare("UPDATE users SET is_active = 0, updated_at = ? WHERE phone_e164 = ?")
    .run(now, phone);
}

export function setUserInactiveById(userId: number): void {
  const database = getDb();
  const now = new Date().toISOString();
  database
    .prepare("UPDATE users SET is_active = 0, updated_at = ? WHERE id = ?")
    .run(now, userId);
}

export function listUsers(): CoachUser[] {
  const database = getDb();
  return database.prepare("SELECT * FROM users ORDER BY created_at DESC").all() as CoachUser[];
}

export function listActiveUsers(): CoachUser[] {
  const database = getDb();
  return database.prepare("SELECT * FROM users WHERE is_active = 1").all() as CoachUser[];
}

export function updateLastCalled(userId: number): void {
  const database = getDb();
  const now = new Date().toISOString();
  database
    .prepare("UPDATE users SET last_called_at = ?, updated_at = ? WHERE id = ?")
    .run(now, now, userId);
}

export function createCallLog(input: {
  user_id: number;
  call_sid?: string | null;
  outcome?: string | null;
}): number {
  const database = getDb();
  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO call_logs
       (user_id, call_sid, outcome, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(input.user_id, input.call_sid ?? null, input.outcome ?? null, now, now);

  const row = database.prepare("SELECT last_insert_rowid() as id").get() as { id: number };
  return row.id;
}

export function updateCallLogBySid(callSid: string, updates: {
  started_at?: string | null;
  ended_at?: string | null;
  outcome?: string | null;
  summary?: string | null;
  metrics_json?: string | null;
}): void {
  const database = getDb();
  const now = new Date().toISOString();
  const current = database
    .prepare("SELECT * FROM call_logs WHERE call_sid = ? ORDER BY id DESC LIMIT 1")
    .get(callSid) as { id: number } | undefined;
  if (!current) return;

  database
    .prepare(
      `UPDATE call_logs
       SET started_at = COALESCE(?, started_at),
           ended_at = COALESCE(?, ended_at),
           outcome = COALESCE(?, outcome),
           summary = COALESCE(?, summary),
           metrics_json = COALESCE(?, metrics_json),
           updated_at = ?
       WHERE id = ?`
    )
    .run(
      updates.started_at ?? null,
      updates.ended_at ?? null,
      updates.outcome ?? null,
      updates.summary ?? null,
      updates.metrics_json ?? null,
      now,
      current.id
    );
}

export function updateCallLogById(callLogId: number, updates: {
  started_at?: string | null;
  ended_at?: string | null;
  outcome?: string | null;
  summary?: string | null;
  metrics_json?: string | null;
}): void {
  const database = getDb();
  const now = new Date().toISOString();
  database
    .prepare(
      `UPDATE call_logs
       SET started_at = COALESCE(?, started_at),
           ended_at = COALESCE(?, ended_at),
           outcome = COALESCE(?, outcome),
           summary = COALESCE(?, summary),
           metrics_json = COALESCE(?, metrics_json),
           updated_at = ?
       WHERE id = ?`
    )
    .run(
      updates.started_at ?? null,
      updates.ended_at ?? null,
      updates.outcome ?? null,
      updates.summary ?? null,
      updates.metrics_json ?? null,
      now,
      callLogId
    );
}

export function getUserById(userId: number): CoachUser | undefined {
  const database = getDb();
  return database.prepare("SELECT * FROM users WHERE id = ?").get(userId) as
    | CoachUser
    | undefined;
}

export function updateUserLevel(userId: number, level: LevelEstimate): void {
  const database = getDb();
  const now = new Date().toISOString();
  database
    .prepare("UPDATE users SET level_estimate = ?, updated_at = ? WHERE id = ?")
    .run(level, now, userId);
}
