/**
 * Server (HTTP API / MCP) configuration, parsed from the `[server]` TOML
 * table. Same token mechanism as `[capture]`: the bearer token itself is
 * never stored in the config file — `token_env` names the environment
 * variable that holds it, read at request time.
 *
 * Auth model: a loopback bind (127.0.0.1, ::1, localhost) needs no token.
 * Any other bind requires `Authorization: Bearer <token>` on `/api/*`,
 * `/mcp` and `/openapi.json`; an unset token env on a non-loopback bind
 * fails closed (every protected route answers 401).
 */

export interface ServerConfig {
  /** Env var that holds the bearer token. Default LINKINBOX_SERVER_TOKEN. */
  tokenEnv: string
}

export const DEFAULT_SERVER_CONFIG: ServerConfig = {
  tokenEnv: 'LINKINBOX_SERVER_TOKEN',
}

function tomlTable(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * Parse the `[server]` table:
 *
 *   [server]
 *   token_env = "LINKINBOX_SERVER_TOKEN"
 */
export function serverFromToml(toml: Record<string, unknown>): ServerConfig {
  const out: ServerConfig = { tokenEnv: DEFAULT_SERVER_CONFIG.tokenEnv }
  const table = tomlTable(toml['server'])
  const tokenEnv = table['token_env']
  if (typeof tokenEnv === 'string' && tokenEnv.trim() !== '') out.tokenEnv = tokenEnv
  return out
}

/** Read the server bearer token from the configured env var (null when unset). */
export function serverToken(config: ServerConfig, env: NodeJS.ProcessEnv): string | null {
  const value = env[config.tokenEnv]
  return value !== undefined && value.trim() !== '' ? value : null
}
