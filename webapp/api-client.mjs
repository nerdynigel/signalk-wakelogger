export class SignalKClient {
  constructor() { this.token = sessionStorage.getItem('wakelogger-onboard-token') || '' }
  async request(path, options = {}) {
    const response = await fetch(path, {
      credentials: 'same-origin', ...options,
      headers: { ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers }
    })
    if (!response.ok) {
      const error = new Error(response.status === 401 || response.status === 403 ? 'Sign in to Signal K to use onboard navigation.' : `Signal K request failed (${response.status}).`)
      error.status = response.status
      throw error
    }
    return response.status === 204 ? null : response.json()
  }
  async signIn(username, password) {
    const result = await this.request('/signalk/v1/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) })
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
  activate() { return this.client.request('/plugins/signalk-wakelogger/course/activate', { method: 'POST', body: '{}' }) }
  async ensureActive(expectedHref) {
    if (!expectedHref) return
    const course = await this.client.request('/signalk/v2/api/vessels/self/navigation/course')
    if (course?.activeRoute?.href !== expectedHref) throw new Error('Another course is now active. Refresh before changing its next point.')
  }
  async setPoint(index, count, expectedHref) {
    if (!Number.isInteger(index) || index < 0 || index >= count) throw new Error('Choose a valid course point.')
    await this.ensureActive(expectedHref)
    return this.client.request('/signalk/v2/api/vessels/self/navigation/course/activeRoute/pointIndex', { method: 'PUT', body: JSON.stringify({ value: index }) })
  }
  async advance(expectedHref) {
    await this.ensureActive(expectedHref)
    return this.client.request('/signalk/v2/api/vessels/self/navigation/course/activeRoute/nextPoint', { method: 'PUT', body: JSON.stringify({ value: 1 }) })
  }
}
