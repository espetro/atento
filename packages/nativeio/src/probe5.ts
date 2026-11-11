import { inflateSync } from "node:zlib";
const out = inflateSync(new Uint8Array([120, 156, 75, 76, 74, 6, 0, 2, 77, 1, 39]));
console.log(out.length);
