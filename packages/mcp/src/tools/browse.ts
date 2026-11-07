/**
 * Browse tools: read one page through a saved browser profile (read-only,
 * share-allowlisted) and list which hosts are shareable.
 */
import { z } from 'zod/mini'
import {
  hostOf,
  type ShareConfig,
} from '@linkinbox/app'
import { json, type ToolDef } from './types.js'

export const browseTools: ToolDef[] = [
  {
    name: 'browse_read',
    description:
      'Read one page through the saved browser profile of its host and ' +
      'return markdown (spec name browse.read). READ-ONLY: no clicks, no ' +
      'typing, no forms. Only the hosts the owner listed in the [share] ' +
      'hosts config may be read (the list ships empty, so by default every ' +
      'call is refused), and only through a profile saved by `linkinbox ' +
      'login`. The read spends the same per-host budget as the pipeline: ' +
      'human pacing, a daily cap, working hours and the circuit breaker. ' +
      'Nothing is written to the link store.',
    inputSchema: z.object({
      url: z.url(),
    }),
    handler: async (env, args: { url: string }) => {
      const { ctx, ops, deps } = env
      const share: ShareConfig = ctx.share ?? { hosts: [] }
      const host = hostOf(args.url)
      if (!deps.browseFn) {
        return json({
          ok: false,
          markdown: '',
          host,
          reason: 'not_configured',
          detail:
            'browsing is not configured in this MCP server; run `linkinbox browse <url>` in the terminal instead',
        })
      }
      const read = await deps.browseFn(ctx)
      const guard = deps.browseGuard ? await deps.browseGuard(ctx) : undefined
      const result = await ops.browseRead(args.url, {
        share,
        read,
        hasProfile: deps.hasProfile
          ? deps.hasProfile
          : async (h) => (await ctx.store.getProfile(h)) !== null,
        guard,
      })
      return json(result)
    },
  },

  {
    name: 'browse_hosts',
    description:
      'Which hosts may be read through a saved browser profile (spec name ' +
      'browse.hosts). Read-only: the saved profiles with their verdict ' +
      'from the [share] hosts allowlist. A host that is not shared can be ' +
      'made shareable by the owner in the config; nothing is shared by ' +
      'default.',
    inputSchema: z.object({}),
    handler: async (env) => {
      const { ctx, ops } = env
      const profiles = await ctx.store.listProfiles()
      const rows = await ops.browseHosts(profiles, ctx.share ?? { hosts: [] })
      return json({
        hosts: rows,
        note: ctx.share === undefined || ctx.share.hosts.length === 0
          ? 'the [share] hosts list is empty: nothing is shared until the owner opts in'
          : undefined,
      })
    },
  },
]
