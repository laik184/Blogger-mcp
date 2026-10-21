import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { zcAuth } from '@zcatalyst/auth';
import { Datastore } from '@zcatalyst/datastore';
import { decryptText, encryptText } from './crypto.js';

const require = createRequire(import.meta.url);
const requestContext = new AsyncLocalStorage();

function parseJson(value) {
  return JSON.parse(value);
}

function catalystKey(collection, key) {
  const digest = createHash('sha256').update(String(key)).digest('hex');
  return `${collection}:${digest}`;
}

function quoteZcql(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll("'", "''");
}

function normalizeRows(response) {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response?.content)) return response.content;
  if (Array.isArray(response?.data)) return response.data;
  return [];
}

function unwrapRow(row) {
  return row?.BAPStore ?? row?.bapstore ?? row;
}

export function openDatabase(databasePath) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
  const Database = require('better-sqlite3');
  const sqlite = new Database(databasePath);
  try { fs.chmodSync(databasePath, 0o600); } catch { /* Managed filesystems may ignore chmod. */ }
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('secure_delete = ON');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.exec(`CREATE TABLE IF NOT EXISTS records (
    collection TEXT NOT NULL,
    record_key TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY(collection, record_key)
  )`);

  const getStatement = sqlite.prepare('SELECT payload_json FROM records WHERE collection=? AND record_key=?');
  const insertStatement = sqlite.prepare('INSERT OR IGNORE INTO records(collection,record_key,payload_json) VALUES(?,?,?)');
  const putStatement = sqlite.prepare(`INSERT INTO records(collection,record_key,payload_json) VALUES(?,?,?)
    ON CONFLICT(collection,record_key) DO UPDATE SET payload_json=excluded.payload_json`);
  const deleteStatement = sqlite.prepare('DELETE FROM records WHERE collection=? AND record_key=?');
  const listStatement = sqlite.prepare('SELECT record_key,payload_json FROM records WHERE collection=? ORDER BY record_key');

  return {
    kind: 'sqlite',
    async get(collection, key) {
      const row = getStatement.get(collection, String(key));
      return row ? parseJson(row.payload_json) : null;
    },
    async insert(collection, key, value) {
      return insertStatement.run(collection, String(key), JSON.stringify(value)).changes === 1;
    },
    async put(collection, key, value) {
      putStatement.run(collection, String(key), JSON.stringify(value));
      return value;
    },
    async delete(collection, key) {
      return deleteStatement.run(collection, String(key)).changes > 0;
    },
    async list(collection) {
      return listStatement.all(collection).map(row => ({ key: row.record_key, value: parseJson(row.payload_json) }));
    },
    close() { sqlite.close(); },
  };
}

export function createCatalystDatabase(config) {
  return {
    kind: 'catalyst',
    config,
    currentDatastore() {
      const current = requestContext.getStore();
      if (!current) throw new Error('Catalyst Data Store is unavailable outside an AppSail request.');
      return current.datastore;
    },
    async findRow(collection, key) {
      const datastore = this.currentDatastore();
      const storageKey = catalystKey(collection, key);
      const query = `SELECT ROWID, RecordKey, Collection, LogicalKey, PayloadEnc FROM BAPStore WHERE RecordKey='${quoteZcql(storageKey)}'`;
      const rows = normalizeRows(await datastore.executeZCQLQuery(query));
      const row = unwrapRow(rows[0]);
      if (!row) return null;
      const encoded = row.PayloadEnc ?? row.payloadenc ?? row.PAYLOADENC;
      if (typeof encoded !== 'string') throw new Error('BAPStore returned a row without PayloadEnc. Check the Data Store table schema.');
      return { rowId: String(row.ROWID ?? row.rowid), value: parseJson(decryptText(encoded, config.encryptionKey)) };
    },
    async get(collection, key) {
      const row = await this.findRow(collection, key);
      return row?.value ?? null;
    },
    async insert(collection, key, value) {
      const datastore = this.currentDatastore();
      const storageKey = catalystKey(collection, key);
      const table = datastore.table('BAPStore');
      const payloadEnc = encryptText(JSON.stringify(value), config.encryptionKey);
      try {
        await table.insertRow({ RecordKey: storageKey, Collection: collection, LogicalKey: String(key), PayloadEnc: payloadEnc });
        return true;
      } catch (error) {
        const row = await this.findRow(collection, key);
        if (row) return false;
        throw error;
      }
    },
    async put(collection, key, value) {
      const datastore = this.currentDatastore();
      const table = datastore.table('BAPStore');
      const payloadEnc = encryptText(JSON.stringify(value), config.encryptionKey);
      let row = await this.findRow(collection, key);
      if (!row) {
        try {
          await table.insertRow({ RecordKey: catalystKey(collection, key), Collection: collection, LogicalKey: String(key), PayloadEnc: payloadEnc });
          return value;
        } catch (error) {
          row = await this.findRow(collection, key);
          if (!row) throw error;
        }
      }
      await table.updateRow({ ROWID: row.rowId, Collection: collection, LogicalKey: String(key), PayloadEnc: payloadEnc });
      return value;
    },
    async delete(collection, key) {
      const datastore = this.currentDatastore();
      const row = await this.findRow(collection, key);
      if (!row) return false;
      await datastore.table('BAPStore').deleteRow(row.rowId);
      return true;
    },
    async list(collection) {
      const datastore = this.currentDatastore();
      const table = datastore.table('BAPStore');
      const records = [];
      let nextToken;
      let moreRecords = true;
      while (moreRecords) {
        const page = await table.getPagedRows({ nextToken, maxRows: 200 });
        const rows = normalizeRows(page);
        for (const row of rows) {
          const normalized = unwrapRow(row);
          const rowCollection = normalized.Collection ?? normalized.collection ?? normalized.COLLECTION;
          const encoded = normalized.PayloadEnc ?? normalized.payloadenc ?? normalized.PAYLOADENC;
          if (rowCollection !== collection || typeof encoded !== 'string') continue;
          records.push({ key: String(normalized.LogicalKey ?? normalized.logicalkey ?? normalized.LOGICALKEY), value: parseJson(decryptText(encoded, config.encryptionKey)) });
        }
        moreRecords = Boolean(page?.more_records);
        nextToken = page?.next_token;
        if (moreRecords && !nextToken) throw new Error('Catalyst Data Store pagination returned more_records without a next_token.');
      }
      return records;
    },
    async runWithRequest(req, next) {
      try {
        const app = await zcAuth.init(req, { scope: 'admin' });
        const datastore = new Datastore(app);
        return requestContext.run({ app, datastore }, next);
      } catch (error) {
        return next(error);
      }
    },
    close() {},
  };
}

export async function getSetting(db, key) {
  const setting = await db.get('settings', key);
  return setting?.value ?? null;
}

export async function setSetting(db, key, value) {
  await db.put('settings', key, { value: String(value) });
}

export async function deleteSetting(db, key) {
  return db.delete('settings', key);
}

export async function getGoogleConnection(db) {
  return db.get('google_connection', 'singleton');
}

export async function setGoogleConnection(db, connection) {
  await db.put('google_connection', 'singleton', connection);
}

export async function writeAudit(db, { event, toolName = null, status, blogId = null, postId = null, detail = null }) {
  const record = {
    created_at: new Date().toISOString(), event, tool_name: toolName, status,
    blog_id: blogId, post_id: postId, detail: detail ? String(detail).slice(0, 500) : null,
  };
  if (db.kind === 'catalyst') {
    console.log(JSON.stringify({ level: status === 'error' ? 'error' : 'info', event: 'audit', ...record }));
    return;
  }
  try { await db.insert('audit_log', randomUUID(), record); }
  catch (error) { console.error(JSON.stringify({ level: 'error', event: 'audit_write_failed', message: error.message })); }
}
