// Native EnrichFn: the @atento/enrich chat model + per-link enrichment,
// adapted to the core EnrichFn shape exactly like
// packages/app/src/adapters/enrich-fn.ts. chat.ts and prompt.ts are vendored
// verbatim (they are already scriptc-subset); the barrel is not imported
// because it pulls in the ASR child_process path.
import { z } from "zod/mini";
import { EnrichmentSchema, type EnrichFn, type Enrichment, type Link } from "@atento/core";
import { buildPrompt } from "./enrich/prompt.ts";
import {
  ENRICHMENT_JSON_SCHEMA,
  chatComplete,
  chatConfigFromEnv,
  parseEnrichment,
  type ChatConfig,
} from "./enrich/chat.ts";

type EnrichFnOut = Awaited<ReturnType<EnrichFn>>;

interface EnrichModel {
  modelId: string;
  generate(req: { system: string; prompt: string }): Promise<{ text: string; tokensIn: number; tokensOut: number }>;
}

function createChatModel(cfg: ChatConfig): EnrichModel {
  return {
    modelId: cfg.model,
    async generate(req) {
      const reply = await chatComplete(cfg, req.system, req.prompt, "enrichment", ENRICHMENT_JSON_SCHEMA);
      if (!reply.ok) throw new Error(reply.error);
      return { text: reply.text, tokensIn: reply.tokensIn, tokensOut: reply.tokensOut };
    },
  };
}

/** enrichLink from packages/enrich/src/run.ts, returning the adapted EnrichFn shape. */
async function enrichLinkNative(link: Link, model: EnrichModel): Promise<EnrichFnOut> {
  const { system, user } = buildPrompt({ link: link });
  const modelId = String(model.modelId);
  let reply: { text: string; tokensIn: number; tokensOut: number };
  try {
    reply = await model.generate({ system: system, prompt: user });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const parsed = parseEnrichment(reply.text);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  // The hand validator and the schema must agree; the schema stays the contract.
  let enrichment: Enrichment;
  try {
    enrichment = z.parse(EnrichmentSchema, parsed.value);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: "No object generated: " + msg };
  }
  return {
    ok: true,
    enrichment: enrichment,
    tokensIn: reply.tokensIn,
    tokensOut: reply.tokensOut,
    modelId: modelId,
  };
}

/**
 * Build the EnrichFn the way createEnrichFn does: the model comes from
 * OPENAI_COMPAT_BASE_URL / OPENAI_COMPAT_API_KEY / ATENTO_MODEL; a missing
 * variable becomes a per-link error, not a crash.
 */
export function createNativeEnrichFn(): EnrichFn {
  let model: EnrichModel;
  let setupError: string | null = null;
  try {
    model = createChatModel(chatConfigFromEnv(process.env));
  } catch (err) {
    setupError = err instanceof Error ? err.message : String(err);
    model = { modelId: "", generate: async () => ({ text: "", tokensIn: 0, tokensOut: 0 }) };
  }
  return async (link: Link): Promise<EnrichFnOut> => {
    if (setupError !== null) {
      return { ok: false, error: "enrichment unavailable: " + setupError };
    }
    return enrichLinkNative(link, model);
  };
}
