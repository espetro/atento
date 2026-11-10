/// <reference path="./shims.d.ts" />
// Probe: does the shim's SQLite have FTS5 / JSON / WAL / backup-ish features atento needs?
import { Database } from "@cutils/sqlite/elf";

const db = Database.open(process.env.ATENTO_DB ?? "/tmp/atento-spike/b.db", { readonly: false });
const sqls = [
  "SELECT count(*) AS n FROM links",
  "SELECT count(*) AS n FROM links_fts WHERE links_fts MATCH 'hello'",
  "SELECT json_extract(enrichment, '$.why_it_matters') AS w FROM links WHERE id = 1",
  "PRAGMA journal_mode = WAL",
  "VACUUM INTO '/tmp/atento-spike/backup.db'",
];
for (const sql of sqls) {
  try {
    const st = db.prepareRaw(sql);
    const r = st.getRaw([]);
    st.finalize();
    console.log("ok   " + sql + " => " + JSON.stringify(r));
  } catch (e) {
    console.log("FAIL " + sql + " => " + String(e));
  }
}
db.close();
