/// <reference path="./shims.d.ts" />
// Minimal config.toml policy loader for the native build: the same file and
// env overrides as packages/app/src/config.ts, parsed with the core TOML
// readers. Only the tables the read-only tools need are loaded.
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
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

function configDir(): string {
  const fromEnv = process.env.ATENTO_CONFIG_DIR;
  if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv;
  const home = process.env.ATENTO_HOME;
  if (home !== undefined && home.trim() !== "") return join(home, ".atento");
  return join(homedir(), ".atento");
}

let cached: NativePolicy | null = null;

/** Load ~/.atento/config.toml once; a missing file yields the defaults. */
export function loadPolicy(): NativePolicy {
  if (cached !== null) return cached;
  const path = join(configDir(), "config.toml");
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  cached = {
    limits: parseLimitsConfig(text),
    login: parseLoginConfig(text),
    pacing: parsePacingConfig(text),
  };
  return cached;
}
