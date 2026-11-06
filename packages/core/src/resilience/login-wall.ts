/**
 * Login-wall detection.
 *
 * After an extractor returns content, the pipeline asks whether the page is
 * really a login wall. The answer decides whether the link needs a browser
 * (`needs_browser` with reason `login_wall`) or was extracted normally.
 *
 * The rules:
 *   - the final URL path looks like a login endpoint
 *   - the page has a password input form and little article text
 *   - the HTTP status is 401, or 403 on a host without a saved profile and
 *     without a bot-block marker in the body (a captcha or challenge 403 is
 *     a bot block, not a wall)
 *   - a shell page: embedded data: images and almost no real text
 *   - sign-up wall phrases at the top of the page, with no saved profile
 */

import { looksLikeBotBlock } from '../pipeline/park-reason.js'

/** Path segments that mark a login endpoint. */
const LOGIN_PATH = /(^|\/)(login|signin|sign-in|auth|accounts)(\/|$)/i

/** Minimum article characters for a page to count as real content. */
export const LOGIN_WALL_MIN_ARTICLE_CHARS = 200

/** True when the final URL path (or an accounts/login subdomain) looks like a login endpoint. */
export function isLoginPath(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (LOGIN_PATH.test(parsed.pathname)) return true
    const labels = parsed.hostname.split('.')
    return labels.some((label) => /^(login|signin|sign-in|accounts?)$/.test(label))
  } catch {
    return false
  }
}

/** True when the HTML carries a password input. */
export function hasPasswordField(html: string): boolean {
  if (!html) return false
  return /<input\b[^>]*type\s*=\s*["']?password/i.test(html)
}

/** The visible text of an HTML page, roughly. */
export function textLength(html: string): number {
  if (!html) return 0
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .length
}

/** Sign-up wall phrases that appear at the top of an anonymous wall page. */
const SIGNUP_WALL = /(Explore jobs and grow your network|New to [A-Z][\w]+\?\s*\[?Join now|Sign in to (view|see|continue)|Log in to (continue|see|view))/i

/** How much of the top of the page the sign-up phrases are searched in. */
const SIGNUP_WALL_HEAD_CHARS = 500

/** Real text of a markdown body: images, data URIs and link targets removed. */
export function substantiveTextLength(markdown: string): number {
  if (!markdown) return 0
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .length
}

export interface LoginWallInput {
  /** The final URL after redirects. */
  url: string
  /** The HTML or markdown the extractor returned. */
  body?: string
  /** The HTTP status of the response. */
  status?: number
  /** True when the host has a saved browser profile. */
  hasProfile?: boolean
  /** Minimum article characters before a password form stops being a wall. */
  minArticleChars?: number
}

/**
 * True when the response is a login wall: the host wants a session we do
 * not have.
 */
export function isLoginWall(input: LoginWallInput): boolean {
  const minChars = input.minArticleChars ?? LOGIN_WALL_MIN_ARTICLE_CHARS
  const body = input.body ?? ''

  if (isLoginPath(input.url)) return true

  if (hasPasswordField(body) && textLength(body) < minChars) return true

  // A shell page: only embedded images, no real text (anonymous Instagram).
  if (/data:image\//i.test(body) && substantiveTextLength(body) < minChars) return true

  // Sign-up wall phrases at the top of an anonymous page.
  if (input.hasProfile !== true && SIGNUP_WALL.test(body.slice(0, SIGNUP_WALL_HEAD_CHARS))) return true

  const status = input.status
  if (status === 401) return true
  if (status === 403 && input.hasProfile !== true && !looksLikeBotBlock(body)) return true

  return false
}
