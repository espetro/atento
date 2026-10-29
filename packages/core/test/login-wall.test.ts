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
