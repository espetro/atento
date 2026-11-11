/// <reference path="./shims.d.ts" />
// Probe: the portable SqlStore running on @cutils/sqlite.
import { SqlStore } from "@atento/db/sql";
import { CutilsDriver } from "./cutils-driver.ts";

async function main(): Promise<void> {
  const path = process.argv[2];
  const store = new SqlStore(CutilsDriver.open(path, false));
  console.log("count " + (await store.countLinks()));
  const l = await store.getLink(1);
  console.log("link1 " + (l === null ? "none" : l.url + " " + l.state));
  console.log(JSON.stringify(await store.countByState()));
  await store.close();
}
await main();
