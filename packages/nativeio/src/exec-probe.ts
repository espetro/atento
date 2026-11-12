import { runBlocking } from "../../media/src/native-exec.js";
const a = runBlocking("echo", ["hello"], 2000);
const b = runBlocking("sleep", ["5"], 300);
console.log(a.code, a.stdout.trim(), b.code, b.timedOut);
