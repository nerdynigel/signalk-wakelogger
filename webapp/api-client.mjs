// Bounded, credentialed-safe diagnostic capture for onboard Signal K requests.
//
// A failed request keeps the operation name, HTTP method/path, status and a
// bounded response/error detail so the crew (and the plugin log) can see why a
// navigation action was rejected instead of an opaque status code. Credentials
// are never attached: the request headers are not read back, and any bearer
// token or token-like value in the response body is redacted before display.
const DETAIL_LIMIT = 2000
const ERROR_FIELDS = ['errorCode', 'error', 'code', 'message', 'detail', 'reason']
const SECRET_PATTERN = /(bearer\s+[A-Za-z0-9._~+/=-]+|(?:token|password|secret|api[_-]?key)\s*[=:]\s*[^\s"']+)/gi

export function boundedDetail(value) {
  return String(value ?? '')
    .replace(SECRET_PATTERN, '[redacted]')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DETAIL_LIMIT)
}

export function parseSignalKError(status, text) {
  const raw = boundedDetail(text)
  if (!raw) return { detail: null, errorCode: null }
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      let errorCode = null
      for (const field of ERROR_FIELDS) {
        const value = parsed[field]
        if (typeof value === 'string' && value.trim()) {
          const bounded = boundedDetail(value)
          if (field === 'errorCode' || field === 'code') errorCode = bounded
          else return { detail: bounded, errorCode }
        }
      }
      if (errorCode) return { detail: errorCode, errorCode }
    }
  } catch { /* Not JSON: fall through to the bounded body text. */ }
  return { detail: raw, errorCode: null }
}

export class SignalKRequestError extends Error {
  constructor({ operation, method, path, status, errorCode = null, detail = null }) {
    const suffix = detail ? `: ${detail}` : ''
    const signedOut = status === 401 || status === 403
    super(signedOut
      ? `Sign in to Signal K to use onboard navigation${detail ? ` (${detail})` : ''}.`
      : `Signal K request failed (${status})${suffix}.`)
    this.name = 'SignalKRequestError'
    this.operation = operation ?? null
    this.method = method ?? null
    this.path = path ?? null
    this.status = status ?? null
    this.errorCode = errorCode ?? null
    this.detail = detail ? boundedDetail(detail) : null
  }

  // A bounded object safe to display, log or send to the plugin diagnostics
  // route. Never contains a request header or credential.
  toDiagnostic() {
    return {
      operation: this.operation,
      method: this.method,
      path: this.path,
      status: this.status,
      errorCode: this.errorCode,
      detail: this.detail
    }
  }
}

export class SignalKClient {
  constructor() { this.token = sessionStorage.getItem('wakelogger-onboard-token') || '' }
  async request(path, options = {}) {
    const method = (options.method || 'GET').toUpperCase()
    const operation = options.operation || path
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 5000
    const { timeoutMs: _ignored, operation: _operation, ...init } = options
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const timer = controller && timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined
    let response
    try {
      response = await fetch(path, {
        credentials: 'same-origin', ...init,
        signal: controller ? controller.signal : undefined,
        headers: { ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers }
      })
    } catch (error) {
      if (controller?.signal.aborted) {
        throw new SignalKRequestError({ operation, method, path, status: 504, errorCode: 'timeout', detail: `Signal K request did not respond within ${timeoutMs} ms` })
      }
      throw error
    } finally {
      if (timer) clearTimeout(timer)
    }
    if (!response.ok) {
      let text = ''
      try { text = await response.text() } catch { /* A missing body still yields a status-only error. */ }
      const { detail, errorCode } = parseSignalKError(response.status, text)
      throw new SignalKRequestError({ operation, method, path, status: response.status, errorCode, detail })
    }
    return response.status === 204 ? null : response.json()
  }
  async signIn(username, password) {
    const result = await this.request('/signalk/v1/auth/login', { method: 'POST', operation: 'sign-in', body: JSON.stringify({ username, password }) })
    if (!result.token) throw new Error('Signal K did not return a session token.')
    this.token = result.token
    sessionStorage.setItem('wakelogger-onboard-token', this.token)
  }
  signOut() { this.token = ''; sessionStorage.removeItem('wakelogger-onboard-token') }
}

// Race-specific advancement rules belong here. For now these are explicit
// operator commands; the app never invents arrival circles or rounding rules.
export class CourseProgressionService {
  constructor(client) { this.client = client }
  activate() { return this.client.request('/plugins/signalk-wakelogger/course/activate', { method: 'POST', operation: 'activate-course', body: '{}' }) }
  async ensureActive(expectedHref) {
    if (!expectedHref) return
    const course = await this.client.request('/signalk/v2/api/vessels/self/navigation/course', { operation: 'read-active-course' })
    if (course?.activeRoute?.href !== expectedHref) throw new Error('Another course is now active. Refresh before changing its next point.')
  }
  async setPoint(index, count, expectedHref) {
    if (!Number.isInteger(index) || index < 0 || index >= count) throw new Error('Choose a valid course point.')
    await this.ensureActive(expectedHref)
    return this.client.request('/signalk/v2/api/vessels/self/navigation/course/activeRoute/pointIndex', { method: 'PUT', operation: 'set-point', body: JSON.stringify({ value: index }) })
  }
  async advance(expectedHref) {
    await this.ensureActive(expectedHref)
    return this.client.request('/signalk/v2/api/vessels/self/navigation/course/activeRoute/nextPoint', { method: 'PUT', operation: 'next-point', body: JSON.stringify({ value: 1 }) })
  }
}

export class RaceProgressionService {
  constructor(client) { this.client = client }
  status() { return this.client.request('/plugins/signalk-wakelogger/progression', { operation: 'read-progression' }) }
  setMode(mode) { return this.client.request('/plugins/signalk-wakelogger/progression/mode', { method: 'POST', operation: 'set-progression-mode', body: JSON.stringify({ mode }) }) }
  resolve(resolution, pointIndex) { return this.client.request('/plugins/signalk-wakelogger/progression/resolve', { method: 'POST', operation: 'resolve-progression', body: JSON.stringify({ resolution, pointIndex }) }) }
}
