import { readFileSync } from "node:fs";
import { extractHtml } from "../../extractors/src/native/extractor.js";

const html = readFileSync(process.argv[2] ?? "", "utf8");
const r = extractHtml(html, process.argv[3] ?? "https://example.com/");
console.log(JSON.stringify({ title: r.title, description: r.meta.description, canonical: r.meta.canonical, words: r.wordCount, links: r.meta.links.length, markdown: r.markdown }));
