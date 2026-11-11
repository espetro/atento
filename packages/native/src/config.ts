/// <reference path="./shims.d.ts" />
// Minimal config.toml policy loader for the native build: the same file and
// env overrides as packages/app/src/config.ts, parsed with the core TOML
// readers. Only the tables the read-only tools need are loaded.
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { parse as parseToml } from "smol-toml";
import {
  parseLimitsConfig,
  parseLoginConfig,
  parsePacingConfig,
  type LimitsConfig,
  type LoginConfig,
  type PacingConfig,
} from "@atento/core";

export interface NativePolicy {
  limits: LimitsConfig;
  login: LoginConfig;
  pacing: PacingConfig;
}

export function configDir(): string {
  const fromEnv = process.env.ATENTO_CONFIG_DIR;
  if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv;
  const home = process.env.ATENTO_HOME;
  if (home !== undefined && home.trim() !== "") return join(home, ".atento");
  return join(homedir(), ".atento");
}

let cachedText: string | null = null;

function configText(): string {
  if (cachedText !== null) return cachedText;
  const path = join(configDir(), "config.toml");
  cachedText = existsSync(path) ? readFileSync(path, "utf8") : "";
  return cachedText;
}

let cached: NativePolicy | null = null;

/** Load ~/.atento/config.toml once; a missing file yields the defaults. */
export function loadPolicy(): NativePolicy {
  if (cached !== null) return cached;
  const text = configText();
  cached = {
    limits: parseLimitsConfig(text),
    login: parseLoginConfig(text),
    pacing: parsePacingConfig(text),
  };
  return cached;
}

/**
 * Resolve the db path like packages/app/src/config.ts: ATENTO_DB, then
 * [db] path in config.toml, then <config-dir>/links.db.
 */
export function dbPath(): string {
  const fromEnv = process.env.ATENTO_DB;
  if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv;
  try {
    const toml = parseToml(configText()) as { [k: string]: unknown };
    const db = toml["db"];
    if (db !== null && typeof db === "object" && !Array.isArray(db)) {
      const p = (db as { [k: string]: unknown })["path"];
      if (typeof p === "string" && p.trim() !== "") return p;
    }
  } catch {
    // A malformed config.toml falls through to the default path.
  }
  return join(configDir(), "links.db");
}
