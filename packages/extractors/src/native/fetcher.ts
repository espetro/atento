// Fetcher with manual redirects, an abort-based timeout and a streamed size cap.
// Authored in the scriptc compilable subset; also runs on Node 20+ unchanged.
// Does not use execFile timeout (vercel-labs/scriptc#3529): the timeout is an AbortController.

export class FetchOptions {
  timeoutMs = 20000;
  maxBytes = 5000000;
  maxRedirects = 5;
  userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
  accept = "text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8";
}

export class FetchResult {
  status = 0;
  body = "";
  bytes: Uint8Array = new Uint8Array(0);
  contentType = "";
  finalUrl = "";
  retryAfter = "";
  truncated = false;
  redirects = 0;
  /** Non-empty when no response was obtained (timeout, DNS, too many redirects). */
  error = "";
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function readCapped(res: Response, max: number, out: FetchResult): Promise<void> {
  const reader = res.body === null ? null : res.body.getReader();
  if (reader === null) return;
  const parts: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const ch = await reader.read();
    if (ch.done) break;
    const v = ch.value as Uint8Array;
    if (total + v.length > max) {
      parts.push(v.slice(0, max - total));
      total = max;
      out.truncated = true;
      await reader.cancel();
      break;
    }
    parts.push(v);
    total += v.length;
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    all.set(p, off);
    off += p.length;
  }
  out.bytes = all;
}

export async function fetchPage(startUrl: string, opts: FetchOptions): Promise<FetchResult> {
  const out = new FetchResult();
  let url = startUrl;
  out.finalUrl = url;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs);
  try {
    for (let hop = 0; hop <= opts.maxRedirects; hop++) {
      const res = await fetch(url, {
        redirect: "manual",
        signal: ac.signal,
        headers: { "user-agent": opts.userAgent, accept: opts.accept },
      });
      out.status = res.status;
      out.finalUrl = url;
      const loc = res.headers.get("location");
      if (isRedirect(res.status) && loc !== null && loc !== "") {
        let next = "";
        try {
          next = new URL(loc, url).href;
        } catch (e) {
          next = "";
        }
        if (next === "") {
          out.error = "bad redirect location";
          break;
        }
        if (hop === opts.maxRedirects) {
          out.error = "too many redirects";
          break;
        }
        url = next;
        out.redirects = hop + 1;
        await res.body?.cancel();
        continue;
      }
      out.contentType = res.headers.get("content-type") ?? "";
      out.retryAfter = res.headers.get("retry-after") ?? "";
      await readCapped(res, opts.maxBytes, out);
      out.body = new TextDecoder().decode(out.bytes);
      break;
    }
  } catch (e) {
    out.error = ac.signal.aborted ? "timeout after " + opts.timeoutMs + "ms" : String(e);
  }
  clearTimeout(timer);
  return out;
}
