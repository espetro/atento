async function main(): Promise<void> {
  const url = process.argv[2] ?? "";
  const r = await fetch(url, { redirect: "manual" });
  console.log("status", r.status, r.headers.get("content-type"), r.headers.get("content-length"));
  const reader = r.body === null ? null : r.body.getReader();
  let total = 0;
  let text = "";
  const dec = new TextDecoder();
  if (reader !== null) {
    while (true) {
      const ch = await reader.read();
      if (ch.done) break;
      const v = ch.value as Uint8Array;
      total += v.length;
      text += dec.decode(v, { stream: true });
      if (total > 20000) {
        await reader.cancel();
        break;
      }
    }
  }
  console.log("total", total, text.length);
}
main();
