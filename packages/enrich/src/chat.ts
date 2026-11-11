// Plain fetch client for OpenAI-compatible chat completions with JSON schema output.
// Authored in the scriptc compilable subset: no imports, so the same file runs on Node and in a
// native binary. No hardcoded provider or model: everything comes from the caller (env in practice).
// LLM code lives only in packages/enrich.

export class ChatConfig {
  baseUrl = "";
  apiKey = "";
  model = "";
  timeoutMs = 60000;
  /** json_schema (default), json_object or none. Some compatible gateways reject json_schema. */
  responseFormat = "json_schema";
}

export class ChatReply {
  ok = false;
  text = "";
  tokensIn = 0;
  tokensOut = 0;
  modelId = "";
  error = "";
}

/** Env keys: OPENAI_COMPAT_BASE_URL, OPENAI_COMPAT_API_KEY, ATENTO_MODEL, ATENTO_RESPONSE_FORMAT, ATENTO_LLM_TIMEOUT_MS. */
export function chatConfigFromEnv(env: { [k: string]: string | undefined }): ChatConfig {
  const baseUrl = env["OPENAI_COMPAT_BASE_URL"];
  const model = env["ATENTO_MODEL"];
  if (baseUrl === undefined || baseUrl === "" || model === undefined || model === "") {
    throw new Error("createModelFromEnv requires OPENAI_COMPAT_BASE_URL and ATENTO_MODEL to be set");
  }
  const c = new ChatConfig();
  c.baseUrl = baseUrl;
  c.model = model;
  const key = env["OPENAI_COMPAT_API_KEY"];
  if (key !== undefined) c.apiKey = key;
  const rf = env["ATENTO_RESPONSE_FORMAT"];
  if (rf !== undefined && rf !== "") c.responseFormat = rf;
  const t = env["ATENTO_LLM_TIMEOUT_MS"];
  if (t !== undefined && t !== "") {
    const n = parseInt(t, 10);
    if (n > 0) c.timeoutMs = n;
  }
  return c;
}

function trimSlash(s: string): string {
  let e = s.length;
  while (e > 0 && s.charAt(e - 1) === "/") e--;
  return s.slice(0, e);
}

function asNumber(x: unknown): number {
  return typeof x === "number" ? x : 0;
}

/** One chat completion. `schemaJson` is the JSON schema as a string. Never throws. */
export async function chatComplete(cfg: ChatConfig, system: string, user: string, schemaName: string, schemaJson: string): Promise<ChatReply> {
  const out = new ChatReply();
  out.modelId = cfg.model;
  let body =
    '{"model":' + JSON.stringify(cfg.model) +
    ',"messages":[{"role":"system","content":' + JSON.stringify(system) +
    '},{"role":"user","content":' + JSON.stringify(user) + "}]";
  if (cfg.responseFormat === "json_schema") {
    body += ',"response_format":{"type":"json_schema","json_schema":{"name":' + JSON.stringify(schemaName) + ',"strict":true,"schema":' + schemaJson + "}}";
  } else if (cfg.responseFormat === "json_object") {
    body += ',"response_format":{"type":"json_object"}';
  }
  body += "}";
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), cfg.timeoutMs);
  try {
    const headers: { [k: string]: string } = { "content-type": "application/json" };
    if (cfg.apiKey !== "") headers["authorization"] = "Bearer " + cfg.apiKey;
    const res = await fetch(trimSlash(cfg.baseUrl) + "/chat/completions", { method: "POST", headers, body, signal: ac.signal });
    const raw = await res.text();
    if (res.status >= 400) {
      out.error = "HTTP " + res.status + ": " + raw.slice(0, 300);
    } else {
      const j = JSON.parse(raw) as { [k: string]: unknown };
      const choices = j["choices"] as unknown[] | undefined;
      if (choices === undefined || choices.length === 0) {
        out.error = "response has no choices";
      } else {
        const first = choices[0] as { [k: string]: unknown };
        const msg = first["message"] as { [k: string]: unknown } | undefined;
        const content = msg === undefined ? undefined : msg["content"];
        if (typeof content !== "string") {
          out.error = "response has no message content";
        } else {
          out.text = content;
          out.ok = true;
        }
        const usage = j["usage"] as { [k: string]: unknown } | undefined;
        if (usage !== undefined) {
          out.tokensIn = asNumber(usage["prompt_tokens"]);
          out.tokensOut = asNumber(usage["completion_tokens"]);
        }
        const mid = j["model"];
        if (typeof mid === "string" && mid !== "") out.modelId = cfg.model;
      }
    }
  } catch (e) {
    out.error = ac.signal.aborted ? "timeout after " + cfg.timeoutMs + "ms" : String(e);
  }
  clearTimeout(timer);
  return out;
}

export class EnrichmentOut {
  category = "";
  priority = "";
  why_it_matters = "";
  read_minutes = 0;
  action = "";
  expires_at: string | null = null;
  expiry_reason: string | null = null;
  confidence = 0;
}

export class EnrichmentParse {
  ok = false;
  error = "";
  value: EnrichmentOut = new EnrichmentOut();
}

/** JSON Schema for the enrichment object. Must stay equal to EnrichmentSchema in @atento/core (parity test). */
export const ENRICHMENT_JSON_SCHEMA =
  '{"type":"object","additionalProperties":false,"required":["category","priority","why_it_matters","read_minutes","action","expires_at","expiry_reason","confidence"],"properties":{' +
  '"category":{"type":"string","minLength":1},' +
  '"priority":{"type":"string","enum":["low","normal","high"]},' +
  '"why_it_matters":{"type":"string","minLength":1},' +
  '"read_minutes":{"type":"integer","minimum":0},' +
  '"action":{"type":"string","enum":["read_now","schedule","archive","discard"]},' +
  '"expires_at":{"type":["string","null"]},' +
  '"expiry_reason":{"type":["string","null"]},' +
  '"confidence":{"type":"number","minimum":0,"maximum":1}}}';

function stripFences(t: string): string {
  let s = t.trim();
  if (s.startsWith("```")) {
    const nl = s.indexOf("\n");
    s = nl < 0 ? "" : s.slice(nl + 1);
    const end = s.lastIndexOf("```");
    if (end >= 0) s = s.slice(0, end);
  }
  return s.trim();
}

function fail(msg: string): EnrichmentParse {
  const p = new EnrichmentParse();
  p.error = msg;
  return p;
}

/** Validate model text against the enrichment schema by hand. Unknown keys are dropped (zod strips them too). */
export function parseEnrichment(text: string): EnrichmentParse {
  let j: { [k: string]: unknown };
  try {
    j = JSON.parse(stripFences(text)) as { [k: string]: unknown };
  } catch (e) {
    return fail("No object generated: response is not valid JSON");
  }
  if (j === null || typeof j !== "object" || Array.isArray(j)) return fail("No object generated: response is not a JSON object");
  const v = new EnrichmentOut();
  const category = j["category"];
  if (typeof category !== "string" || category === "") return fail("No object generated: category must be a non-empty string");
  v.category = category;
  const priority = j["priority"];
  if (priority !== "low" && priority !== "normal" && priority !== "high") return fail("No object generated: priority must be low, normal or high");
  v.priority = priority;
  const why = j["why_it_matters"];
  if (typeof why !== "string" || why === "") return fail("No object generated: why_it_matters must be a non-empty string");
  v.why_it_matters = why;
  const rm = j["read_minutes"];
  if (typeof rm !== "number" || Math.floor(rm) !== rm || rm < 0) return fail("No object generated: read_minutes must be a non-negative integer");
  v.read_minutes = rm;
  const action = j["action"];
  if (action !== "read_now" && action !== "schedule" && action !== "archive" && action !== "discard") return fail("No object generated: action is not one of read_now, schedule, archive, discard");
  v.action = action;
  const ea = j["expires_at"];
  if (ea === null) v.expires_at = null;
  else if (typeof ea === "string") v.expires_at = ea;
  else return fail("No object generated: expires_at must be a string or null");
  const er = j["expiry_reason"];
  if (er === null) v.expiry_reason = null;
  else if (typeof er === "string") v.expiry_reason = er;
  else return fail("No object generated: expiry_reason must be a string or null");
  const conf = j["confidence"];
  if (typeof conf !== "number" || conf < 0 || conf > 1) return fail("No object generated: confidence must be a number between 0 and 1");
  v.confidence = conf;
  const p = new EnrichmentParse();
  p.ok = true;
  p.value = v;
  return p;
}
