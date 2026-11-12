import { readFileSync } from "node:fs";
import { extractPdfText } from "../../extractors/src/native/pdf.js";
const r = extractPdfText(new Uint8Array(readFileSync(process.argv[2] ?? "")), 10000);
console.log(r.engine, r.error, r.text.length);
console.log(r.text.slice(0, 300));
