// SqlDriver over @cutils/sqlite, so the portable SqlStore (@atento/db/sql) runs in a scriptc build.
import { Database } from "@cutils/sqlite/elf";
import type { SqlDriver, SqlRow, SqlRunResult, SqlValue } from "@atento/db/sql";

export class CutilsDriver implements SqlDriver {
  db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /** Open a database file; writable unless `readonly`. Same durability pragmas as the Node store. */
  static open(path: string, readonly: boolean): CutilsDriver {
    const db = Database.open(path, readonly ? { readonly: true } : { fileMustExist: true });
    const d = new CutilsDriver(db);
    if (!readonly) {
      d.pragma("busy_timeout = 5000", false);
      d.pragma("foreign_keys = ON", false);
      d.pragma("synchronous = FULL", false);
    }
    return d;
  }

  get inTransaction(): boolean {
    return this.db.inTransaction;
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  run(sql: string, params?: SqlValue[]): SqlRunResult {
    const st = this.db.prepareRaw(sql);
    const r = st.runRaw(params === undefined ? [] : params);
    st.finalize();
    return { changes: r.changes, lastInsertRowid: Number(r.lastInsertRowid) };
  }

  get(sql: string, params?: SqlValue[]): SqlRow | undefined {
    const st = this.db.prepareRaw(sql);
    const row = st.getRaw(params === undefined ? [] : params);
    st.finalize();
    if (row === null || row === undefined) return undefined;
    return row as SqlRow;
  }

  all(sql: string, params?: SqlValue[]): SqlRow[] {
    const st = this.db.prepareRaw(sql);
    const rows = st.allRaw(params === undefined ? [] : params);
    st.finalize();
    return rows as SqlRow[];
  }

  pragma(source: string, simple?: boolean): unknown {
    const rows = this.db.pragma(source).rows;
    if (simple !== true) return rows;
    if (rows.length === 0) return undefined;
    const first = rows[0] as { [k: string]: unknown };
    const keys = Object.keys(first);
    return keys.length === 0 ? undefined : first[keys[0]];
  }

  close(): void {
    this.db.close();
  }
}
