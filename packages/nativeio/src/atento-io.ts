// Native end-to-end entry: fetch a URL, extract it, enrich it through an OpenAI-compatible endpoint.
// No Node island: every import is a first-party file compiled by scriptc.
import { extractUrlWithBrowser } from "../../extractors/src/native/extractor.js";
import { FetchOptions } from "../../extractors/src/native/fetcher.js";
import { browserdConfigFromEnv } from "../../extractors/src/native/browserd.js";
import { buildPrompt } from "../../enrich/src/prompt.js";
import { ENRICHMENT_JSON_SCHEMA, chatComplete, chatConfigFromEnv, parseEnrichment } from "../../enrich/src/chat.js";

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "";
  const url = process.argv[3] ?? "";
  if ((cmd !== "extract" && cmd !== "enrich") || url === "") {
    console.error("usage: atento-io extract|enrich <url>");
    process.exit(2);
  }
  const fo = new FetchOptions();
  const tmo = process.env["ATENTO_FETCH_TIMEOUT_MS"];
  if (tmo !== undefined && parseInt(tmo, 10) > 0) fo.timeoutMs = parseInt(tmo, 10);
  const cap = process.env["ATENTO_FETCH_MAX_BYTES"];
  if (cap !== undefined && parseInt(cap, 10) > 0) fo.maxBytes = parseInt(cap, 10);
  const ex = await extractUrlWithBrowser(url, fo, browserdConfigFromEnv(process.env));
  if (cmd === "extract") {
    console.log(
      JSON.stringify({
        url,
        finalUrl: ex.finalUrl,
        status: ex.status,
        title: ex.title,
        description: ex.meta.description,
        canonical: ex.meta.canonical,
        ogType: ex.meta.ogType,
        links: ex.meta.links.length,
        words: ex.wordCount,
        needsBrowser: ex.needsBrowser,
        gone: ex.gone,
        markdown: ex.markdown,
      }),
    );
    return;
  }
  const cfg = chatConfigFromEnv(process.env);
  const p = buildPrompt({ link: { url, title: ex.title === "" ? null : ex.title, addedAt: null, extractedContent: ex.markdown }, now: new Date() });
  const reply = await chatComplete(cfg, p.system, p.user, "enrichment", ENRICHMENT_JSON_SCHEMA);
  if (!reply.ok) {
    console.log(JSON.stringify({ ok: false, stage: "model", error: reply.error }));
    process.exit(1);
  }
  const parsed = parseEnrichment(reply.text);
  if (!parsed.ok) {
    console.log(JSON.stringify({ ok: false, stage: "parse", error: parsed.error }));
    process.exit(1);
  }
  const v = parsed.value;
  console.log(
    JSON.stringify({
      ok: true,
      modelId: reply.modelId,
      tokensIn: reply.tokensIn,
      tokensOut: reply.tokensOut,
      title: ex.title,
      words: ex.wordCount,
      enrichment: { category: v.category, priority: v.priority, why_it_matters: v.why_it_matters, read_minutes: v.read_minutes, action: v.action, expires_at: v.expires_at, expiry_reason: v.expiry_reason, confidence: v.confidence },
    }),
  );
}
main();
