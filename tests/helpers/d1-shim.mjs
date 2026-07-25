// A minimal stand-in for the D1 binding, backed by node:sqlite.
//
// The point is not to emulate D1 faithfully — it is to run the exact SQL
// strings the handlers send, so a typo or an unsupported construct fails in a
// test instead of in production. D1 is SQLite, so the SQL is the part worth
// checking; the wire protocol is not.

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

const MIGRATIONS = [
  'migrations/0001_baseline.sql',
  'migrations/0002_courses_layouts_holes.sql',
  'migrations/0003_ingest_state.sql',
  'migrations/0004_rate_limits.sql',
];

class Statement {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...params) {
    return new Statement(this.db, this.sql, params);
  }

  #args() {
    return this.params.map((p) => {
      if (p === undefined) throw new Error('D1_TYPE_ERROR: undefined bound value');
      if (typeof p === 'boolean') return p ? 1 : 0;
      return p;
    });
  }

  async first(column) {
    const row = this.db.prepare(this.sql).get(...this.#args()) ?? null;
    if (row && column !== undefined) return row[column] ?? null;
    return row;
  }

  async all() {
    const results = this.db.prepare(this.sql).all(...this.#args());
    return { results, success: true, meta: {} };
  }

  async run() {
    const info = this.db.prepare(this.sql).run(...this.#args());
    return { success: true, meta: { changes: Number(info.changes ?? 0) } };
  }
}

export class FakeD1 {
  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.db.exec('PRAGMA foreign_keys = ON');
    for (const m of MIGRATIONS) {
      this.db.exec(readFileSync(join(root, m), 'utf8'));
    }
  }

  prepare(sql) {
    return new Statement(this.db, sql);
  }

  // D1 batches run in a single implicit transaction.
  async batch(statements) {
    this.db.exec('BEGIN');
    try {
      const out = [];
      for (const s of statements) out.push(await s.run());
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  exec(sql) {
    this.db.exec(sql);
    return { count: 0, duration: 0 };
  }

  close() {
    this.db.close();
  }
}

/** Build the context object a Pages Function receives. */
export function ctx({ method = 'GET', url = 'https://x.test/api/', body = null, token = 'tok', params = {} } = {}) {
  const headers = new Headers();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return {
    request: new Request(url, { method, headers }),
    data: { body },
    params,
  };
}
