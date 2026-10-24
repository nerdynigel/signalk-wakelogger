import type { Delta } from '@signalk/server-api'
import { GuidanceEngine, type GuidanceConfig, type GuidanceInput, type GuidanceSnapshot, type Reading, type WindReading } from './core'
export const GUIDANCE_PATHS = [
  'navigation.headingTrue', 'navigation.headingMagnetic', 'navigation.magneticVariation',
  'navigation.speedOverGround', 'navigation.courseOverGroundTrue', 'navigation.speedThroughWater',
  'navigation.rateOfTurn', 'navigation.attitude', 'navigation.leewayAngle', 'steering.rudderAngle',
  'environment.wind.speedApparent', 'environment.wind.angleApparent',
  'environment.wind.speedTrue', 'environment.wind.angleTrueWater',
  'environment.wind.speedOverGround', 'environment.wind.directionTrue',
  'environment.current.setTrue', 'environment.current.drift'
] as const
const knots = 1.9438444924406, degrees = 180 / Math.PI
export class GuidanceService {
  private values = new Map<string, Reading>()
  private session: string | undefined
  private engine: GuidanceEngine
  constructor(private readonly config: GuidanceConfig = {}) { this.engine = new GuidanceEngine(config) }
  get enabled(): boolean { return this.config.enabled !== false }
  seedRest(navigation: Record<string, unknown>, environment: Record<string, unknown>, steering: Record<string, unknown> = {}, now = Date.now()): void {
    const roots: Record<string, unknown> = { navigation, environment, steering }
    const updates: unknown[] = []
    for (const path of GUIDANCE_PATHS) {
      let node: unknown = roots
      for (const key of path.split('.')) node = node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined
      if (!node || typeof node !== 'object' || !Number.isFinite(Date.parse(String((node as Record<string, unknown>).timestamp ?? '')))) {
        this.values.delete(path)
        if (path === 'navigation.attitude') for (const key of ['heel', 'pitch', 'yaw']) this.values.delete(key)
        continue
      }
      const reading = node as Record<string, unknown>
      updates.push({ timestamp: reading.timestamp, source: { label: String(reading.$source ?? 'rest') }, values: [{ path, value: reading.value }] })
    }
    this.ingest({ context: 'vessels.self', updates } as unknown as Delta, now)
  }
  reset(): void { this.values.clear(); this.engine.reset() }
  ingest(delta: Delta, now = Date.now()): void {
    for (const update of delta.updates) {
      if (!('values' in update)) continue
      const at = Date.parse(String(update.timestamp ?? ''))
      const sourceInfo = update.source as { label?: string; type?: string; src?: string; talker?: string } | undefined
      const source = `${sourceInfo?.label ?? sourceInfo?.type ?? ''}:${sourceInfo?.src ?? sourceInfo?.talker ?? ''}`
      for (const item of update.values) {
        const name = String(item.path)
        if (!(GUIDANCE_PATHS as readonly string[]).includes(name)) continue
        const old = this.values.get(name)
        if (item.state?.timedOut || item.value === null) { this.values.delete(name); if (name === 'navigation.attitude') for (const key of ['heel', 'pitch', 'yaw']) this.values.delete(key); continue }
        if (!Number.isFinite(at) || at > now + 1000 || now - at > 30000 || old && at < old.at) continue
        if (name === 'navigation.attitude') {
          const attitude = item.value as Record<string, unknown>
          for (const [key, field] of [['heel', 'roll'], ['pitch', 'pitch'], ['yaw', 'yaw']] as const) {
            const value = attitude?.[field]
            if (typeof value === 'number' && Number.isFinite(value)) this.values.set(key, { value: value * degrees, at, source })
            else this.values.delete(key)
          }
        } else if (typeof item.value === 'number' && Number.isFinite(item.value)) this.values.set(name, { value: item.value, at, source })
        else this.values.delete(name)
      }
    }
    this.snapshot(now)
  }
  snapshot(now = Date.now(), session?: string): GuidanceSnapshot | null {
    if (session !== undefined) this.session = session
    if (this.config.enabled === false) return null
    const get = (name: string, scale = 1): Reading | null => {
      const value = this.values.get(name)
      return value && now - value.at <= 30000 && now >= value.at - 1000 ? { ...value, value: value.value * scale } : null
    }
    let heading = get('navigation.headingTrue', degrees)
    if (!heading) {
      const magnetic = get('navigation.headingMagnetic', degrees), variation = get('navigation.magneticVariation', degrees)
      if (magnetic && variation && Math.abs(magnetic.at - variation.at) <= 10000)
        heading = { value: magnetic.value + variation.value, at: Math.min(magnetic.at, variation.at), source: 'magnetic-plus-variation:' + magnetic.source }
    }
    const sog = get('navigation.speedOverGround', knots), cog = get('navigation.courseOverGroundTrue', degrees)
    const coherent = (items: Array<Reading | null>): items is Reading[] => items.every((r): r is Reading => !!r) && Math.max(...items.map(r => r.at)) - Math.min(...items.map(r => r.at)) <= 2000
    let wind: WindReading | null = null, current: WindReading | null = null
    let waterWind: WindReading | null = null, apparentWind: WindReading | null = null
    const aws = get('environment.wind.speedApparent', knots), awa = get('environment.wind.angleApparent', degrees)
    const waterSpeed = get('environment.wind.speedTrue', knots), waterAngle = get('environment.wind.angleTrueWater', degrees)
    if (waterSpeed && waterAngle && heading && coherent([waterSpeed, waterAngle, heading]) && waterSpeed.value >= 0 && waterSpeed.value <= 200 && Math.abs(waterAngle.value) <= 360) {
      const from = (heading.value + waterAngle.value) / degrees
      waterWind = { east: waterSpeed.value * Math.sin(from), north: waterSpeed.value * Math.cos(from), at: Math.min(waterSpeed.at, waterAngle.at, heading.at), source: 'water:' + waterSpeed.source + ':' + waterAngle.source + ':' + heading.source }
    }
    if (aws && awa && heading && coherent([aws, awa, heading]) && aws.value > 0 && aws.value <= 120 && Math.abs(awa.value) <= 360) {
      const from = (heading.value + awa.value) / degrees
      apparentWind = { east: aws.value * Math.sin(from), north: aws.value * Math.cos(from), at: Math.min(aws.at, awa.at, heading.at), source: aws.source + ':' + heading.source }
    }
    const groundSpeed = get('environment.wind.speedOverGround', knots), groundDirection = get('environment.wind.directionTrue')
    if (groundSpeed && groundDirection && coherent([groundSpeed, groundDirection]) && groundSpeed.value >= 0 && groundSpeed.value <= 200)
      wind = { east: groundSpeed.value * Math.sin(groundDirection.value), north: groundSpeed.value * Math.cos(groundDirection.value), at: Math.min(groundSpeed.at, groundDirection.at), source: 'ground:' + groundSpeed.source + ':' + groundDirection.source }
    else {
      if (aws && awa && heading && sog && cog && coherent([aws, awa, heading, sog, cog]) && aws.value > 0 && aws.value <= 120 && sog.value >= 0 && sog.value <= 80) {
        const from = (heading.value + awa.value) / degrees, motion = cog.value / degrees
        wind = { east: aws.value * Math.sin(from) - sog.value * Math.sin(motion), north: aws.value * Math.cos(from) - sog.value * Math.cos(motion),
          at: Math.min(aws.at, awa.at), validUntil: Math.min(aws.at, awa.at, heading.at, sog.at, cog.at) + 30000, source: 'apparent-ground:' + aws.source + ':' + heading.source + ':' + sog.source }
      }
    }
    const set = get('environment.current.setTrue'), drift = get('environment.current.drift', knots)
    if (set && drift && coherent([set, drift]) && drift.value >= 0 && drift.value <= 15)
      current = { east: drift.value * Math.sin(set.value), north: drift.value * Math.cos(set.value), at: Math.min(set.at, drift.at), source: set.source + ':' + drift.source }
    const input: GuidanceInput = { at: now, session: this.session, heading, wind, waterWind, apparentWind, current, sog, cog, stw: get('navigation.speedThroughWater', knots),
      heel: get('heel'), pitch: get('pitch'), yaw: get('yaw'), rudder: get('steering.rudderAngle', degrees), leeway: get('navigation.leewayAngle', degrees), rateOfTurn: get('navigation.rateOfTurn', degrees) }
    return this.engine.update(input)
  }
}
