import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export function openDatabase(databasePath) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
  const db = new Database(databasePath);
  try { fs.chmodSync(databasePath, 0o600); } catch { /* Windows and managed mounts may ignore chmod. */ }
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('secure_delete = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS google_connection (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      google_sub TEXT NOT NULL,
      email TEXT NOT NULL,
      display_name TEXT,
      refresh_token_enc TEXT NOT NULL,
      access_token_enc TEXT,
      token_expiry INTEGER,
      blog_id TEXT,
      blog_name TEXT,
      blog_url TEXT,
      connected_at TEXT NOT NULL,
      setup_complete INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS auth_flows (
      state_hash TEXT PRIMARY KEY,
      browser_hash TEXT NOT NULL,
      purpose TEXT NOT NULL CHECK (purpose IN ('setup', 'login')),
      request_json TEXT,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_clients (
      client_id TEXT PRIMARY KEY,
      client_name TEXT NOT NULL,
      redirect_uris_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_codes (
      code_hash TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      google_sub TEXT NOT NULL,
      scope TEXT NOT NULL,
      code_challenge TEXT NOT NULL,
      resource TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      FOREIGN KEY(client_id) REFERENCES oauth_clients(client_id)
    );
    CREATE TABLE IF NOT EXISTS oauth_access_tokens (
      token_hash TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      google_sub TEXT NOT NULL,
      scope TEXT NOT NULL,
      resource TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
      token_hash TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      google_sub TEXT NOT NULL,
      scope TEXT NOT NULL,
      resource TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS idempotency (
      blog_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('in_progress', 'succeeded', 'failed')),
      uncertain INTEGER NOT NULL DEFAULT 0,
      post_id TEXT,
      post_url TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(blog_id, idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      event TEXT NOT NULL,
      tool_name TEXT,
      status TEXT NOT NULL,
      blog_id TEXT,
      post_id TEXT,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_auth_flows_expires ON auth_flows(expires_at);
    CREATE INDEX IF NOT EXISTS idx_oauth_codes_expires ON oauth_codes(expires_at);
    CREATE INDEX IF NOT EXISTS idx_oauth_access_expires ON oauth_access_tokens(expires_at);
    CREATE INDEX IF NOT EXISTS idx_oauth_refresh_expires ON oauth_refresh_tokens(expires_at);
  `);
  const idempotencyColumns = new Set(db.prepare('PRAGMA table_info(idempotency)').all().map(column => column.name));
  if (!idempotencyColumns.has('uncertain')) {
    db.exec('ALTER TABLE idempotency ADD COLUMN uncertain INTEGER NOT NULL DEFAULT 0');
  }
  return db;
}

export function getSetting(db, key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
}

export function setSetting(db, key, value) {
  db.prepare(`INSERT INTO settings(key,value) VALUES(?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, String(value));
}

export function getGoogleConnection(db) {
  return db.prepare('SELECT * FROM google_connection WHERE singleton = 1').get() ?? null;
}

export function writeAudit(db, { event, toolName = null, status, blogId = null, postId = null, detail = null }) {
  db.prepare(`INSERT INTO audit_log(created_at,event,tool_name,status,blog_id,post_id,detail)
    VALUES(?,?,?,?,?,?,?)`).run(new Date().toISOString(), event, toolName, status, blogId, postId,
    detail ? String(detail).slice(0, 500) : null);
}
