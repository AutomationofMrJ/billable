// Browser demo only: the subset of the better-sqlite3 API that server/store.ts and server/schema.ts use,
// implemented on sql.js (SQLite compiled to WebAssembly). The real server keeps using better-sqlite3.
import type { Database as SqlJsDatabase, SqlJsStatic, SqlValue } from 'sql.js';

let SQL: SqlJsStatic | null = null;
/** Saved database bytes by path, loaded from IndexedDB before the first store opens. */
export const files = new Map<string, Uint8Array>();
export function useSqlJs(sql: SqlJsStatic) { SQL = sql; }

type Param = SqlValue | boolean | undefined;
const bindable = (params: Param[]) => params.map(p => p === undefined ? null : typeof p === 'boolean' ? Number(p) : p) as SqlValue[];
/** better-sqlite3 tags constraint and trigger failures with an SQLITE_CONSTRAINT code; the API maps that to 409. */
function sqliteError(error: unknown): never {
  if (error instanceof Error && /constraint failed|immutable/i.test(error.message)) Object.assign(error, { code: 'SQLITE_CONSTRAINT' });
  throw error;
}

class Statement {
  constructor(private db: SqlJsDatabase, private sql: string) {}
  private each<T>(params: Param[], fn: (st: ReturnType<SqlJsDatabase['prepare']>) => T): T {
    const st = this.db.prepare(this.sql);
    try { st.bind(bindable(params)); return fn(st); } catch (e) { sqliteError(e); } finally { st.free(); }
  }
  all(...params: Param[]) { return this.each(params, st => { const rows: Record<string, SqlValue>[] = []; while (st.step()) rows.push(st.getAsObject()); return rows; }); }
  get(...params: Param[]) { return this.each(params, st => st.step() ? st.getAsObject() : undefined); }
  run(...params: Param[]) { this.each(params, st => { st.step(); }); return { changes: this.db.getRowsModified() }; }
}

export default class Database {
  readonly raw: SqlJsDatabase;
  private depth = 0;
  constructor(public path: string) {
    if (!SQL) throw new Error('SQLite is still loading.');
    this.raw = new SQL.Database(files.get(path));
  }
  prepare(sql: string) { return new Statement(this.raw, sql); }
  exec(sql: string) { try { this.raw.exec(sql); } catch (e) { sqliteError(e); } return this; }
  pragma(source: string, options?: { simple?: boolean }) {
    const result = this.raw.exec(`PRAGMA ${source}`)[0];
    if (options?.simple) return result?.values[0]?.[0];
    return (result?.values ?? []).map(row => Object.fromEntries(result!.columns.map((c, i) => [c, row[i]])));
  }
  /** Savepoints make nested transactions behave like better-sqlite3: an inner failure rolls back only its own work. */
  transaction<A extends unknown[], R>(fn: (...args: A) => R) {
    const run = (...args: A): R => {
      const name = `billable_sp${this.depth++}`;
      this.raw.exec(`SAVEPOINT ${name}`);
      try { const result = fn(...args); this.raw.exec(`RELEASE ${name}`); return result; }
      catch (e) { this.raw.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw e; }
      finally { this.depth--; }
    };
    return Object.assign(run, { immediate: run, deferred: run, exclusive: run });
  }
  /** sql.js reopens the database on export, which resets connection pragmas. */
  export() { const bytes = this.raw.export(); this.raw.exec('PRAGMA foreign_keys = ON'); return bytes; }
  close() { this.raw.close(); }
}
