/**
 * Transport-agnostic tool definitions. A ToolDef is a plain object —
 * name, description, a zod/mini input schema and a handler — that every
 * transport (stdio, streamable HTTP, tests) wraps without knowing MCP
 * specifics. Handlers receive a per-call ToolEnv: the resolved McpContext,
 * the shared McpDeps and the app-layer ops built over that context's
 * store. They never reach into store/pipeline internals beyond what
 * LinkinboxOps exposes.
 */
import { z } from 'zod/mini'
import {
  createLinkinboxOps,
  type LinkinboxOps,
} from '@linkinbox/app'
import type { McpContext, McpDeps } from '../deps.js'

/** Serialize an MCP tool result: compact JSON as the text payload. */
export function json(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] }
}

export interface ToolTextContent {
  type: 'text'
  text: string
}

export interface ToolResult {
  content: ToolTextContent[]
  isError?: boolean
}

/** Everything a tool handler needs for one call. */
export interface ToolEnv {
  deps: McpDeps
  /** The resolved MCP context (store, ttl, logger, config fields). */
  ctx: McpContext
  /** The app-layer use cases bound to ctx.store. */
  ops: LinkinboxOps
}

export type ToolHandler = (env: ToolEnv, args: any) => Promise<ToolResult>

export interface ToolDef {
  name: string
  description: string
  /** zod/mini object schema for the tool arguments. */
  inputSchema: z.ZodMiniObject
  handler: ToolHandler
}

/**
 * The use cases for one MCP context: the same app layer the CLI and the
 * HTTP server drive, bound to the context's store and config fields. Built
 * per call — it is a plain object over the store, no I/O happens until a
 * use case runs.
 */
export function opsFor(ctx: McpContext): LinkinboxOps {
  return createLinkinboxOps(
    {
      ttl: ctx.ttl,
      ...(ctx.limits ? { limits: ctx.limits } : {}),
      ...(ctx.login ? { login: ctx.login } : {}),
      ...(ctx.share ? { share: ctx.share } : {}),
    },
    {
      store: ctx.store,
      logger: ctx.logger,
      ...(ctx.spoolDir !== undefined ? { spoolDir: ctx.spoolDir } : {}),
    },
  )
}

/**
 * Resolve the per-call environment and run one tool. Every transport goes
 * through this so ctx() resolution and ops construction stay identical.
 */
export async function callTool(
  deps: McpDeps,
  tool: ToolDef,
  args: unknown,
): Promise<ToolResult> {
  const ctx = await deps.ctx()
  const env: ToolEnv = { deps, ctx, ops: opsFor(ctx) }
  return tool.handler(env, args)
}
