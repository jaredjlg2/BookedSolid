import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { env } from "../config/env.js";

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
  call_prompt: string | null;
  call_instructions: string | null;
  password_hash: string | null;
  is_active: number;
  consented_at: string | null;
  last_called_at: string | null;
  created_at: string;
  updated_at: string;
}

const nodeRequire = createRequire(import.meta.url);

type Statement = {
  get: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => unknown[];
  run: (...params: unknown[]) => unknown;
};

type DatabaseHandle = {
  exec: (sql: string) => void;
  prepare: (sql: string) => Statement;
};

let db: DatabaseHandle | null = null;
let store: CoachStore | null = null;

function ensureDbPath(dbPath: string) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

type CoachStore = {
  upsertUser: (input: {
    phone_e164: string;
    name?: string | null;
    timezone: string;
    preferred_call_hour_local: number;
    preferred_call_minute_local: number;
    duolingo_unit?: string | null;
    call_prompt?: string | null;
    call_instructions?: string | null;
    password_hash?: string | null;
  }) => CoachUser;
  getUserByPhone: (phone: string) => CoachUser | undefined;
  setUserPassword: (phone: string, passwordHash: string) => void;
  updateUserPreferences: (
    userId: number,
      updates: {
        name?: string | null;
        timezone?: string;
        preferred_call_hour_local?: number;
        preferred_call_minute_local?: number;
        level_estimate?: LevelEstimate;
        duolingo_unit?: string | null;
        call_prompt?: string | null;
        call_instructions?: string | null;
      }
    ) => CoachUser | undefined;
  setUserInactive: (phone: string) => void;
  setUserInactiveById: (userId: number) => void;
  listUsers: () => CoachUser[];
  listActiveUsers: () => CoachUser[];
  updateLastCalled: (userId: number) => void;
  createCallLog: (input: { user_id: number; call_sid?: string | null; outcome?: string | null }) => number;
  updateCallLogBySid: (
    callSid: string,
    updates: {
      started_at?: string | null;
      ended_at?: string | null;
      outcome?: string | null;
      summary?: string | null;
      metrics_json?: string | null;
    }
  ) => void;
  updateCallLogById: (
    callLogId: number,
    updates: {
      started_at?: string | null;
      ended_at?: string | null;
      outcome?: string | null;
      summary?: string | null;
      metrics_json?: string | null;
    }
  ) => void;
  getUserById: (userId: number) => CoachUser | undefined;
  updateUserLevel: (userId: number, level: LevelEstimate) => void;
};

function getStore(): CoachStore {
  if (!store) {
    store = initializeStore();
  }
  return store;
}

function getDb(): DatabaseHandle {
  if (!db) {
    const dbPath =
      env.DB_PATH ?? path.join(os.homedir() || process.cwd(), ".coach", "data", "coach.sqlite");
    ensureDbPath(dbPath);
    const driver = loadDatabaseDriver();
    db = driver.create(dbPath);
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

function initializeStore(): CoachStore {
  try {
    const database = getDb();
    return createSqlStore(database);
  } catch (error) {
    console.warn(
      "SQLite driver not available; falling back to an in-memory store. Data will not persist across restarts."
    );
    console.warn(error);
    return createMemoryStore();
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
      call_prompt TEXT,
      call_instructions TEXT,
      password_hash TEXT,
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

  const columns = database.prepare("PRAGMA table_info(users)").all() as { name: string }[];
  const existingColumns = new Set(columns.map((column) => column.name));
  if (!existingColumns.has("password_hash")) {
    database.exec("ALTER TABLE users ADD COLUMN password_hash TEXT;");
  }
  if (!existingColumns.has("call_prompt")) {
    database.exec("ALTER TABLE users ADD COLUMN call_prompt TEXT;");
  }
  if (!existingColumns.has("call_instructions")) {
    database.exec("ALTER TABLE users ADD COLUMN call_instructions TEXT;");
  }
}

function createSqlStore(database: DatabaseHandle): CoachStore {
  return {
    upsertUser(input) {
      const now = new Date().toISOString();

      const existing = database
        .prepare("SELECT * FROM users WHERE phone_e164 = ?")
        .get(input.phone_e164) as CoachUser | undefined;

      if (existing) {
        database
          .prepare(
            `UPDATE users
             SET name = ?, timezone = ?, preferred_call_hour_local = ?, preferred_call_minute_local = ?,
                 duolingo_unit = ?, call_prompt = ?, call_instructions = ?, password_hash = COALESCE(?, password_hash),
                 is_active = 1, consented_at = ?, updated_at = ?
             WHERE phone_e164 = ?`
          )
          .run(
            input.name ?? existing.name,
            input.timezone,
            input.preferred_call_hour_local,
            input.preferred_call_minute_local,
            input.duolingo_unit ?? existing.duolingo_unit,
            input.call_prompt ?? existing.call_prompt,
            input.call_instructions ?? existing.call_instructions,
            input.password_hash ?? null,
            now,
            now,
            input.phone_e164
          );
      } else {
        database
          .prepare(
            `INSERT INTO users
             (phone_e164, name, timezone, preferred_call_hour_local, preferred_call_minute_local, level_estimate,
              duolingo_unit, call_prompt, call_instructions, password_hash, is_active, consented_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'A0', ?, ?, ?, ?, 1, ?, ?, ?)`
          )
          .run(
            input.phone_e164,
            input.name ?? null,
            input.timezone,
            input.preferred_call_hour_local,
            input.preferred_call_minute_local,
            input.duolingo_unit ?? null,
            input.call_prompt ?? null,
            input.call_instructions ?? null,
            input.password_hash ?? null,
            now,
            now,
            now
          );
      }

      return database
        .prepare("SELECT * FROM users WHERE phone_e164 = ?")
        .get(input.phone_e164) as CoachUser;
    },
    getUserByPhone(phone) {
      return database.prepare("SELECT * FROM users WHERE phone_e164 = ?").get(phone) as
        | CoachUser
        | undefined;
    },
    setUserPassword(phone, passwordHash) {
      const now = new Date().toISOString();
      database
        .prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE phone_e164 = ?")
        .run(passwordHash, now, phone);
    },
    updateUserPreferences(userId, updates) {
      const now = new Date().toISOString();
      const existing = database.prepare("SELECT * FROM users WHERE id = ?").get(userId) as
        | CoachUser
        | undefined;
      if (!existing) return;
      database
        .prepare(
          `UPDATE users
           SET name = COALESCE(?, name),
               timezone = COALESCE(?, timezone),
               preferred_call_hour_local = COALESCE(?, preferred_call_hour_local),
               preferred_call_minute_local = COALESCE(?, preferred_call_minute_local),
               level_estimate = COALESCE(?, level_estimate),
               duolingo_unit = COALESCE(?, duolingo_unit),
               call_prompt = COALESCE(?, call_prompt),
               call_instructions = COALESCE(?, call_instructions),
               updated_at = ?
           WHERE id = ?`
        )
        .run(
          updates.name ?? null,
          updates.timezone ?? null,
          updates.preferred_call_hour_local ?? null,
          updates.preferred_call_minute_local ?? null,
          updates.level_estimate ?? null,
          updates.duolingo_unit ?? null,
          updates.call_prompt ?? null,
          updates.call_instructions ?? null,
          now,
          userId
        );
      return database.prepare("SELECT * FROM users WHERE id = ?").get(userId) as CoachUser;
    },
    setUserInactive(phone) {
      const now = new Date().toISOString();
      database
        .prepare("UPDATE users SET is_active = 0, updated_at = ? WHERE phone_e164 = ?")
        .run(now, phone);
    },
    setUserInactiveById(userId) {
      const now = new Date().toISOString();
      database
        .prepare("UPDATE users SET is_active = 0, updated_at = ? WHERE id = ?")
        .run(now, userId);
    },
    listUsers() {
      return database.prepare("SELECT * FROM users ORDER BY created_at DESC").all() as CoachUser[];
    },
    listActiveUsers() {
      return database.prepare("SELECT * FROM users WHERE is_active = 1").all() as CoachUser[];
    },
    updateLastCalled(userId) {
      const now = new Date().toISOString();
      database
        .prepare("UPDATE users SET last_called_at = ?, updated_at = ? WHERE id = ?")
        .run(now, now, userId);
    },
    createCallLog(input) {
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
    },
    updateCallLogBySid(callSid, updates) {
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
    },
    updateCallLogById(callLogId, updates) {
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
    },
    getUserById(userId) {
      return database.prepare("SELECT * FROM users WHERE id = ?").get(userId) as
        | CoachUser
        | undefined;
    },
    updateUserLevel(userId, level) {
      const now = new Date().toISOString();
      database
        .prepare("UPDATE users SET level_estimate = ?, updated_at = ? WHERE id = ?")
        .run(level, now, userId);
    },
  };
}

type MemoryCallLog = {
  id: number;
  user_id: number;
  call_sid: string | null;
  started_at: string | null;
  ended_at: string | null;
  outcome: string | null;
  summary: string | null;
  metrics_json: string | null;
  created_at: string;
  updated_at: string;
};

function createMemoryStore(): CoachStore {
  let nextUserId = 1;
  let nextCallLogId = 1;
  const users = new Map<number, CoachUser>();
  const usersByPhone = new Map<string, CoachUser>();
  const callLogs = new Map<number, MemoryCallLog>();

  const listUserValues = () =>
    Array.from(users.values()).sort((a, b) => b.created_at.localeCompare(a.created_at));

  return {
    upsertUser(input) {
      const now = new Date().toISOString();
      const existing = usersByPhone.get(input.phone_e164);
      if (existing) {
        const updated: CoachUser = {
          ...existing,
          name: input.name ?? existing.name,
          timezone: input.timezone,
          preferred_call_hour_local: input.preferred_call_hour_local,
          preferred_call_minute_local: input.preferred_call_minute_local,
          duolingo_unit: input.duolingo_unit ?? existing.duolingo_unit,
          call_prompt: input.call_prompt ?? existing.call_prompt,
          call_instructions: input.call_instructions ?? existing.call_instructions,
          password_hash: input.password_hash ?? existing.password_hash,
          is_active: 1,
          consented_at: now,
          updated_at: now,
        };
        users.set(updated.id, updated);
        usersByPhone.set(updated.phone_e164, updated);
        return updated;
      }

      const created: CoachUser = {
        id: nextUserId++,
        phone_e164: input.phone_e164,
        name: input.name ?? null,
        timezone: input.timezone,
        preferred_call_hour_local: input.preferred_call_hour_local,
        preferred_call_minute_local: input.preferred_call_minute_local,
        level_estimate: "A0",
        duolingo_unit: input.duolingo_unit ?? null,
        call_prompt: input.call_prompt ?? null,
        call_instructions: input.call_instructions ?? null,
        password_hash: input.password_hash ?? null,
        is_active: 1,
        consented_at: now,
        last_called_at: null,
        created_at: now,
        updated_at: now,
      };

      users.set(created.id, created);
      usersByPhone.set(created.phone_e164, created);
      return created;
    },
    getUserByPhone(phone) {
      return usersByPhone.get(phone);
    },
    setUserPassword(phone, passwordHash) {
      const existing = usersByPhone.get(phone);
      if (!existing) return;
      const now = new Date().toISOString();
      const updated: CoachUser = { ...existing, password_hash: passwordHash, updated_at: now };
      users.set(updated.id, updated);
      usersByPhone.set(updated.phone_e164, updated);
    },
    updateUserPreferences(userId, updates) {
      const existing = users.get(userId);
      if (!existing) return;
      const now = new Date().toISOString();
      const updated: CoachUser = {
        ...existing,
        name: updates.name ?? existing.name,
        timezone: updates.timezone ?? existing.timezone,
        preferred_call_hour_local: updates.preferred_call_hour_local ?? existing.preferred_call_hour_local,
        preferred_call_minute_local:
          updates.preferred_call_minute_local ?? existing.preferred_call_minute_local,
        level_estimate: updates.level_estimate ?? existing.level_estimate,
        duolingo_unit: updates.duolingo_unit ?? existing.duolingo_unit,
        call_prompt: updates.call_prompt ?? existing.call_prompt,
        call_instructions: updates.call_instructions ?? existing.call_instructions,
        updated_at: now,
      };
      users.set(updated.id, updated);
      usersByPhone.set(updated.phone_e164, updated);
      return updated;
    },
    setUserInactive(phone) {
      const existing = usersByPhone.get(phone);
      if (!existing) return;
      const now = new Date().toISOString();
      const updated: CoachUser = { ...existing, is_active: 0, updated_at: now };
      users.set(updated.id, updated);
      usersByPhone.set(updated.phone_e164, updated);
    },
    setUserInactiveById(userId) {
      const existing = users.get(userId);
      if (!existing) return;
      const now = new Date().toISOString();
      const updated: CoachUser = { ...existing, is_active: 0, updated_at: now };
      users.set(updated.id, updated);
      usersByPhone.set(updated.phone_e164, updated);
    },
    listUsers() {
      return listUserValues();
    },
    listActiveUsers() {
      return listUserValues().filter((user) => user.is_active === 1);
    },
    updateLastCalled(userId) {
      const existing = users.get(userId);
      if (!existing) return;
      const now = new Date().toISOString();
      const updated: CoachUser = { ...existing, last_called_at: now, updated_at: now };
      users.set(updated.id, updated);
      usersByPhone.set(updated.phone_e164, updated);
    },
    createCallLog(input) {
      const now = new Date().toISOString();
      const callLog: MemoryCallLog = {
        id: nextCallLogId++,
        user_id: input.user_id,
        call_sid: input.call_sid ?? null,
        started_at: null,
        ended_at: null,
        outcome: input.outcome ?? null,
        summary: null,
        metrics_json: null,
        created_at: now,
        updated_at: now,
      };
      callLogs.set(callLog.id, callLog);
      return callLog.id;
    },
    updateCallLogBySid(callSid, updates) {
      const candidates = Array.from(callLogs.values()).filter((log) => log.call_sid === callSid);
      if (candidates.length === 0) return;
      const current = candidates.reduce((latest, log) => (log.id > latest.id ? log : latest));
      const now = new Date().toISOString();
      const updated: MemoryCallLog = {
        ...current,
        started_at: updates.started_at ?? current.started_at,
        ended_at: updates.ended_at ?? current.ended_at,
        outcome: updates.outcome ?? current.outcome,
        summary: updates.summary ?? current.summary,
        metrics_json: updates.metrics_json ?? current.metrics_json,
        updated_at: now,
      };
      callLogs.set(updated.id, updated);
    },
    updateCallLogById(callLogId, updates) {
      const current = callLogs.get(callLogId);
      if (!current) return;
      const now = new Date().toISOString();
      const updated: MemoryCallLog = {
        ...current,
        started_at: updates.started_at ?? current.started_at,
        ended_at: updates.ended_at ?? current.ended_at,
        outcome: updates.outcome ?? current.outcome,
        summary: updates.summary ?? current.summary,
        metrics_json: updates.metrics_json ?? current.metrics_json,
        updated_at: now,
      };
      callLogs.set(updated.id, updated);
    },
    getUserById(userId) {
      return users.get(userId);
    },
    updateUserLevel(userId, level) {
      const existing = users.get(userId);
      if (!existing) return;
      const now = new Date().toISOString();
      const updated: CoachUser = { ...existing, level_estimate: level, updated_at: now };
      users.set(updated.id, updated);
      usersByPhone.set(updated.phone_e164, updated);
    },
  };
}

export function upsertUser(input: {
  phone_e164: string;
  name?: string | null;
  timezone: string;
  preferred_call_hour_local: number;
  preferred_call_minute_local: number;
  duolingo_unit?: string | null;
  call_prompt?: string | null;
  call_instructions?: string | null;
  password_hash?: string | null;
}): CoachUser {
  return getStore().upsertUser(input);
}

export function getUserByPhone(phone: string): CoachUser | undefined {
  return getStore().getUserByPhone(phone);
}

export function setUserPassword(phone: string, passwordHash: string): void {
  getStore().setUserPassword(phone, passwordHash);
}

export function updateUserPreferences(
  userId: number,
  updates: {
    name?: string | null;
    timezone?: string;
    preferred_call_hour_local?: number;
    preferred_call_minute_local?: number;
    level_estimate?: LevelEstimate;
    duolingo_unit?: string | null;
    call_prompt?: string | null;
    call_instructions?: string | null;
  }
): CoachUser | undefined {
  return getStore().updateUserPreferences(userId, updates);
}

export function setUserInactive(phone: string): void {
  getStore().setUserInactive(phone);
}

export function setUserInactiveById(userId: number): void {
  getStore().setUserInactiveById(userId);
}

export function listUsers(): CoachUser[] {
  return getStore().listUsers();
}

export function listActiveUsers(): CoachUser[] {
  return getStore().listActiveUsers();
}

export function updateLastCalled(userId: number): void {
  getStore().updateLastCalled(userId);
}

export function createCallLog(input: {
  user_id: number;
  call_sid?: string | null;
  outcome?: string | null;
}): number {
  return getStore().createCallLog(input);
}

export function updateCallLogBySid(callSid: string, updates: {
  started_at?: string | null;
  ended_at?: string | null;
  outcome?: string | null;
  summary?: string | null;
  metrics_json?: string | null;
}): void {
  getStore().updateCallLogBySid(callSid, updates);
}

export function updateCallLogById(callLogId: number, updates: {
  started_at?: string | null;
  ended_at?: string | null;
  outcome?: string | null;
  summary?: string | null;
  metrics_json?: string | null;
}): void {
  getStore().updateCallLogById(callLogId, updates);
}

export function getUserById(userId: number): CoachUser | undefined {
  return getStore().getUserById(userId);
}

export function updateUserLevel(userId: number, level: LevelEstimate): void {
  getStore().updateUserLevel(userId, level);
}
