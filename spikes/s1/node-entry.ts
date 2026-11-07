// Node-side parity runner: same server.ts, Node runtime + koffi sqlite binding.
import "koffi";
import "@cutils/sqlite/node-binding";
await import("./server.js");
