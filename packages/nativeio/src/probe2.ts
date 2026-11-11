async function main(): Promise<void> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 1500);
  try {
    const r = await fetch("http://127.0.0.1:8098/slow", { signal: ac.signal, method: "POST", headers: { "content-type": "application/json", authorization: "Bearer x" }, body: JSON.stringify({ a: 1 }) });
    console.log("status", r.status);
    const reader = r.body === null ? null : r.body.getReader();
    if (reader !== null) {
      const chunk = await reader.read();
      console.log("chunk", chunk.done);
    }
  } catch (e) {
    console.log("err", String(e));
  }
  clearTimeout(timer);
  console.log("done");
}
main();
