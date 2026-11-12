import { extractUrl } from "../../extractors/src/native/extractor.js";
import { FetchOptions } from "../../extractors/src/native/fetcher.js";

async function main(): Promise<void> {
  const o = new FetchOptions();
  o.timeoutMs = 3000;
  o.maxBytes = 200000;
  const r = await extractUrl(process.argv[2] ?? "", o);
  console.log(JSON.stringify({ status: r.status, finalUrl: r.finalUrl, title: r.title, needsBrowser: r.needsBrowser, gone: r.gone, words: r.wordCount }));
}
main();
