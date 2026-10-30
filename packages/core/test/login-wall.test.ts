/**
 * Login-wall detection fixtures: no network, pure string inputs.
 */
import { describe, expect, it } from 'vitest'
import {
  hasPasswordField,
  isLoginPath,
  isLoginWall,
  textLength,
} from '../src/resilience/login-wall.js'

const ARTICLE = `<html><body><article>${'word '.repeat(200)}</article></body></html>`
const LOGIN_FORM = `<html><body><form><input type="password" name="pass"></form></body></html>`

describe('isLoginPath', () => {
  it('matches login-ish path segments', () => {
    for (const url of [
      'https://example.com/login?next=/post',
      'https://example.com/signin',
      'https://example.com/sign-in/here',
      'https://accounts.example.com/oauth',
      'https://example.com/auth/github',
    ]) {
      expect(isLoginPath(url)).toBe(true)
    }
    for (const url of [
      'https://example.com/blog/author-login-tips',
      'https://example.com/2024/01/a-story',
    ]) {
      expect(isLoginPath(url)).toBe(false)
    }
    expect(isLoginPath('not a url')).toBe(false)
  })
})

describe('hasPasswordField and textLength', () => {
  it('detects a password input and measures visible text', () => {
    expect(hasPasswordField(LOGIN_FORM)).toBe(true)
    expect(hasPasswordField(ARTICLE)).toBe(false)
    expect(hasPasswordField('')).toBe(false)
    expect(textLength(ARTICLE)).toBeGreaterThan(200)
    expect(textLength(LOGIN_FORM)).toBeLessThan(50)
  })
})

describe('isLoginWall', () => {
  it('flags a login-path final URL', () => {
    expect(isLoginWall({ url: 'https://example.com/signin', body: ARTICLE })).toBe(true)
  })

  it('flags a password form with little article text', () => {
    expect(isLoginWall({ url: 'https://example.com/post', body: LOGIN_FORM })).toBe(true)
    // A real article with a password field (weird but not a wall).
    expect(isLoginWall({ url: 'https://example.com/post', body: ARTICLE + LOGIN_FORM })).toBe(false)
  })

  it('flags 401 always and 403 only without a saved profile', () => {
    expect(isLoginWall({ url: 'https://example.com/post', status: 401 })).toBe(true)
    expect(isLoginWall({ url: 'https://example.com/post', status: 403 })).toBe(true)
    expect(
      isLoginWall({ url: 'https://example.com/post', status: 403, hasProfile: true }),
    ).toBe(false)
    expect(isLoginWall({ url: 'https://example.com/post', status: 200, body: ARTICLE })).toBe(false)
  })
})

describe('isLoginWall: content-level walls', () => {
  it('flags a shell page of data: images with no text', () => {
    const body = `![](data:image/png;base64,${'A'.repeat(5000)})\n\n![](data:image/png;base64,${'B'.repeat(5000)})`
    expect(isLoginWall({ url: 'https://example.com/p/abc/', body })).toBe(true)
  })

  it('keeps a page with real text next to a data: image', () => {
    const body = `![](data:image/png;base64,AAAA)\n\n${'A real caption with substance. '.repeat(20)}`
    expect(isLoginWall({ url: 'https://example.com/p/abc/', body })).toBe(false)
  })

  it('flags a sign-up wall at the top of an anonymous page', () => {
    const body = '## Explore jobs and grow your network\n\nNew to LinkedIn? [Join now](https://www.linkedin.com/signup)\n\n' + 'Jobs. '.repeat(500)
    expect(isLoginWall({ url: 'https://www.linkedin.com/posts/x', body })).toBe(true)
  })

  it('does not flag the sign-up phrases once the host has a profile', () => {
    const body = '## Explore jobs and grow your network\n\n' + 'Jobs. '.repeat(500)
    expect(isLoginWall({ url: 'https://www.linkedin.com/posts/x', body, hasProfile: true })).toBe(false)
  })

  it('keeps a short real post', () => {
    expect(isLoginWall({ url: 'https://x.com/a/status/1', body: '## Post\n\nShort but real tweet text here.' })).toBe(false)
  })
})
