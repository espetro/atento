/**
 * The frames tier: NOT IMPLEMENTED YET. The tier exists so the gap is
 * visible in every report; the reason string is stable so callers can match
 * on it.
 *
 * Planned interface (for whoever picks this up):
 *
 *   export interface FrameTierOptions {
 *     ffmpeg: string              // binary, default "ffmpeg"
 *     count: number               // N keyframes, default 3
 *     vision: VisionFn            // (frames: {path: string}[]) => Promise<string>
 *   }
 *
 *   // 1. ffmpeg -i input.mp4 -vf "select=eq(n\\,0)" -frames:v N frame-%02d.jpg
 *   //    (or fps-based: -vf "fps=1/30" for one frame every 30 seconds)
 *   // 2. hand the jpgs to a local vision provider (one call, images attached)
 *   // 3. return on-screen text (OCR) plus a short visual description
 */
export const FRAMES_UNSUPPORTED_REASON = 'frame analysis not implemented'

import type { TierResult } from './types.js'

/** The frames tier result: always unsupported, by design, for now. */
export function framesTier(seconds = 0): TierResult {
  return {
    kind: 'unsupported',
    tier: 'frames',
    status: 'unsupported',
    seconds,
    reason: FRAMES_UNSUPPORTED_REASON,
  }
}
