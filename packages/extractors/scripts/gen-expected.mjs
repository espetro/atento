import { readFile, writeFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import Defuddle from "defuddle";
import TurndownService from "turndown";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "..", "..", "..", "fixtures", "extractors");

const write = process.argv.includes("--write");
const slugs = (await readdir(fixtures, { withFileTypes: true }))
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

for (const slug of slugs) {
  const dir = join(fixtures, slug);
  const html = await readFile(join(dir, "page.html"), "utf8");
  const meta = JSON.parse(await readFile(join(dir, "meta.json"), "utf8"));
  const { document } = parseHTML(html);
  const result = new Defuddle(document, { url: meta.url }).parse();
  const content = result.content ?? "";
  globalThis.document = document;
  const md = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" })
    .turndown(content)
    .trim();
  console.log(`=== ${slug} === chars=${md.length} title=${result.title}`);
  for (const phrase of meta.mustNotContain ?? []) {
    if (new RegExp(phrase, "i").test(md)) console.log(`  LEAK: ${phrase}`);
  }
  const { min, max } = meta.charRange;
  if (md.length < min || md.length > max) console.log(`  CHAR RANGE VIOLATION (${min}-${max})`);
  if (write) await writeFile(join(dir, "expected.md"), md + "\n", "utf8");
}
