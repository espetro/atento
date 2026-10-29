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
 *   - the HTTP status is 401 or 403 on a host without a saved profile
 */

/** Path segments that mark a login endpoint. */
const LOGIN_PATH = /(^|\/)(login|signin|sign-in|auth|accounts)(\/|$)/i

/** Minimum article characters for a page to count as real content. */
export const LOGIN_WALL_MIN_ARTICLE_CHARS = 200

/** True when the final URL path looks like a login endpoint. */
export function isLoginPath(url: string): boolean {
  try {
    const parsed = new URL(url)
    return LOGIN_PATH.test(parsed.pathname)
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

  const status = input.status
  if (status === 401) return true
  if (status === 403 && input.hasProfile !== true) return true

  return false
}
