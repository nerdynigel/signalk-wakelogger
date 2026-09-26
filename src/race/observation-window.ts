// Frozen raw observation aggregation for `race_plan_dynamic_v1`.
//
// This module is the single source of truth for turning a five-minute window of
// raw Signal K samples into the observed wind/navigation summary, and is
// mirrored field-for-field by the cloud implementation in
// `api/app/services/race_observation_aggregation.py`. The shared raw fixture
// `test/fixtures/observation_golden.json` plus the cross-repo harness prove the
// two engines stay equivalent.
//
// Chosen model (documented, identical in both repos):
//  - scalar speeds (TWS/SOG/STW/heel): arithmetic mean over qualifying samples;
//  - directions (TWD/heading/COG): circular mean;
//  - gust: maximum of (gust, else TWS) over qualifying samples;
//  - true wind: direct true wind per sample when present, otherwise derived from
//    that sample's apparent wind plus its own motion/heading sample (never from
//    separately averaged inputs);
//  - readiness: 300 s window, 240 s covered span, 30 qualifying samples, newest
//    qualifying sample within 30 s, valid wind and valid position.

import { normalizeDegrees } from './sailing/physics'

export interface SailingAverageSample {
  at: number
  twsKnots?: number | null
  twdDeg?: number | null
  gustKnots?: number | null
  headingDeg?: number | null
  cogDeg?: number | null
  sogKnots?: number | null
  stwKnots?: number | null
  heelDeg?: number | null
  awsKnots?: number | null
  awaDeg?: number | null
  apparentDirectionDeg?: number | null
  latitude?: number | null
  longitude?: number | null
}

export interface SailingAverages {
  twsKnots: number | null
  twdDeg: number | null
  gustKnots: number | null
  headingDeg: number | null
  cogDeg: number | null
  sogKnots: number | null
  stwKnots: number | null
  heelDeg: number | null
  awsKnots: number | null
  awaDeg: number | null
  sampleCount: number
  windowSeconds: number
  windSource: 'true' | 'derived' | null
  /** Number of samples carrying a complete qualifying wind + navigation reading. */
  qualifyingSampleCount: number
  /** Actual timespan covered by the qualifying samples. */
  coveredSeconds: number
  /** Age of the newest qualifying sample at evaluation time. */
  latestSampleAgeSeconds: number | null
}

export interface ObservationReadiness {
  ready: boolean
  reason: 'ready' | 'no_samples' | 'span_too_short' | 'too_few_samples' | 'stale' | 'no_wind' | 'no_position'
  sampleCount: number
  qualifyingSampleCount: number
  coveredSeconds: number
  latestSampleAgeSeconds: number | null
}

export const OBSERVATION_WINDOW_SECONDS = 300
export const OBSERVATION_WINDOW_MS = OBSERVATION_WINDOW_SECONDS * 1000
export const OBSERVATION_MIN_SPAN_SECONDS = 240
export const OBSERVATION_MIN_SAMPLES = 30
export const OBSERVATION_MAX_AGE_SECONDS = 30

const POSITION_STALE_SECONDS = OBSERVATION_MAX_AGE_SECONDS

export interface DerivedSampleWind {
  twsKnots: number
  twdDeg: number
  direct: boolean
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function inRange(value: unknown, min: number, max: number): value is number {
  return finite(value) && value >= min && value <= max
}

function mean(values: number[]): number | null {
  if (!values.length) return null
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

export function circularMean(values: number[]): number | null {
  if (!values.length) return null
  let x = 0
  let y = 0
  for (const value of values) {
    const radians = value * Math.PI / 180
    x += Math.cos(radians)
    y += Math.sin(radians)
  }
  if (Math.abs(x) < 1e-9 && Math.abs(y) < 1e-9) return null
  return ((Math.atan2(y, x) * 180 / Math.PI) % 360 + 360) % 360
}

// Deterministic per-sample apparent-to-true conversion. Uses the heading to
// place the apparent angle, and course-over-ground plus speed-over-ground for
// the boat vector, matching the cloud engine exactly. Missing instruments are
// never fabricated.
export function deriveTrueWindSample(sample: {
  twsKnots?: number | null
  twdDeg?: number | null
  headingDeg?: number | null
  cogDeg?: number | null
  sogKnots?: number | null
  stwKnots?: number | null
  awsKnots?: number | null
  awaDeg?: number | null
  apparentDirectionDeg?: number | null
}): DerivedSampleWind | null {
  if (inRange(sample.twsKnots, 0, 200) && inRange(sample.twdDeg, 0, 360)) {
    return { twsKnots: sample.twsKnots, twdDeg: normalizeDegrees(sample.twdDeg), direct: true }
  }
  if (!inRange(sample.awsKnots, 0, 120) || sample.awsKnots <= 0) return null
  const heading = finite(sample.headingDeg) ? sample.headingDeg : null
  const cog = finite(sample.cogDeg) ? sample.cogDeg : null
  if (heading === null && cog === null) return null
  const sog = inRange(sample.sogKnots, 0, 80) ? sample.sogKnots : null
  const stw = inRange(sample.stwKnots, 0, 80) ? sample.stwKnots : null
  // Prefer the ground vector (COG + SOG) so the onboard engine matches the cloud
  // exactly; fall back to the water vector (heading + STW) when ground motion is
  // unavailable. The reference and speed always come from the same frame.
  let boatReference: number
  let boatSpeed: number
  if (sog !== null) {
    boatReference = cog ?? heading!
    boatSpeed = sog
  } else if (stw !== null) {
    boatReference = heading ?? cog!
    boatSpeed = stw
  } else {
    return null
  }
  let apparentFromDeg: number | null = null
  if (finite(sample.apparentDirectionDeg)) apparentFromDeg = normalizeDegrees(sample.apparentDirectionDeg)
  else if (finite(sample.awaDeg)) apparentFromDeg = normalizeDegrees((heading ?? cog ?? 0) + sample.awaDeg)
  if (apparentFromDeg === null) return null
  const apparentTo = normalizeDegrees(apparentFromDeg + 180)
  const apparentRadians = apparentTo * Math.PI / 180
  const boatRadians = normalizeDegrees(boatReference) * Math.PI / 180
  const x = Math.sin(apparentRadians) * sample.awsKnots + Math.sin(boatRadians) * boatSpeed
  const y = Math.cos(apparentRadians) * sample.awsKnots + Math.cos(boatRadians) * boatSpeed
  const speed = Math.hypot(x, y)
  if (!Number.isFinite(speed) || speed <= 0.05) return null
  const trueTo = normalizeDegrees(Math.atan2(x, y) * 180 / Math.PI)
  return { twsKnots: speed, twdDeg: normalizeDegrees(trueTo + 180), direct: false }
}

function hasNavigationReference(sample: SailingAverageSample): boolean {
  return finite(sample.sogKnots) || finite(sample.cogDeg) || finite(sample.headingDeg)
}

export function observationReadiness(averages: SailingAverages | null | undefined, position: { latitude: number; longitude: number } | null = null): ObservationReadiness {
  const empty: ObservationReadiness = { ready: false, reason: 'no_samples', sampleCount: 0, qualifyingSampleCount: 0, coveredSeconds: 0, latestSampleAgeSeconds: null }
  if (!averages || averages.sampleCount === 0) return empty
  const base = { sampleCount: averages.sampleCount, qualifyingSampleCount: averages.qualifyingSampleCount, coveredSeconds: averages.coveredSeconds, latestSampleAgeSeconds: averages.latestSampleAgeSeconds }
  if (averages.twsKnots === null || averages.twdDeg === null) return { ...empty, ...base, reason: 'no_wind' }
  if (position === null) return { ...empty, ...base, reason: 'no_position' }
  if (averages.qualifyingSampleCount < OBSERVATION_MIN_SAMPLES) return { ...empty, ...base, reason: 'too_few_samples' }
  if (averages.coveredSeconds < OBSERVATION_MIN_SPAN_SECONDS) return { ...empty, ...base, reason: 'span_too_short' }
  if (averages.latestSampleAgeSeconds === null || averages.latestSampleAgeSeconds > OBSERVATION_MAX_AGE_SECONDS) return { ...empty, ...base, reason: 'stale' }
  return { ready: true, reason: 'ready', ...base }
}

// The one raw aggregation entry point. Both the live collector (via
// RollingAverages) and the cross-repo harness call this.
export function aggregateObservationSamples(samples: SailingAverageSample[], now: number, windowMs = OBSERVATION_WINDOW_MS): SailingAverages {
  const cutoff = now - windowMs
  const inWindow = samples.filter((sample) => Number.isFinite(sample.at) && sample.at >= cutoff && sample.at <= now)
  const windowSeconds = Math.round(windowMs / 1000)
  if (!inWindow.length) {
    return {
      twsKnots: null, twdDeg: null, gustKnots: null, headingDeg: null, cogDeg: null, sogKnots: null, stwKnots: null,
      heelDeg: null, awsKnots: null, awaDeg: null, sampleCount: 0, windowSeconds, windSource: null,
      qualifyingSampleCount: 0, coveredSeconds: 0, latestSampleAgeSeconds: null
    }
  }

  const wind: Array<{ at: number; twsKnots: number; twdDeg: number; direct: boolean; gustKnots: number }> = []
  for (const sample of inWindow) {
    if (!hasNavigationReference(sample)) continue
    const derived = deriveTrueWindSample(sample)
    if (!derived) continue
    const gust = inRange(sample.gustKnots, 0, 250) ? sample.gustKnots : derived.twsKnots
    wind.push({ at: sample.at, twsKnots: derived.twsKnots, twdDeg: derived.twdDeg, direct: derived.direct, gustKnots: gust })
  }
  const firstWind = wind[0]
  const lastWind = wind[wind.length - 1]
  const hasDirect = wind.some((entry) => entry.direct)
  const tws = wind.length ? mean(wind.map((entry) => entry.twsKnots)) : null
  const twd = wind.length ? circularMean(wind.map((entry) => entry.twdDeg)) : null
  return {
    twsKnots: tws === null ? null : round(tws, 2),
    twdDeg: twd === null ? null : round(twd, 1),
    gustKnots: wind.length ? round(Math.max(...wind.map((entry) => entry.gustKnots)), 2) : null,
    headingDeg: roundOrNull(circularMean(inWindow.map((sample) => sample.headingDeg).filter(finite)), 1),
    cogDeg: roundOrNull(circularMean(inWindow.map((sample) => sample.cogDeg).filter(finite)), 1),
    sogKnots: roundOrNull(mean(inWindow.map((sample) => sample.sogKnots).filter(finite)), 3),
    stwKnots: roundOrNull(mean(inWindow.map((sample) => sample.stwKnots).filter(finite)), 3),
    heelDeg: roundOrNull(mean(inWindow.map((sample) => sample.heelDeg).filter(finite)), 1),
    awsKnots: roundOrNull(mean(inWindow.map((sample) => sample.awsKnots).filter(finite)), 2),
    awaDeg: roundOrNull(mean(inWindow.map((sample) => sample.awaDeg).filter(finite)), 1),
    sampleCount: inWindow.length,
    windowSeconds,
    windSource: wind.length ? (hasDirect ? 'true' : 'derived') : null,
    qualifyingSampleCount: wind.length,
    coveredSeconds: firstWind && lastWind ? Math.max(0, Math.round((lastWind.at - firstWind.at) / 1000)) : 0,
    latestSampleAgeSeconds: lastWind ? Math.max(0, Math.round((now - lastWind.at) / 1000)) : null
  }
}

function roundOrNull(value: number | null, digits: number): number | null {
  return value === null ? null : round(value, digits)
}

export interface AggregatedObservationWindow {
  averages: SailingAverages
  position: { latitude: number; longitude: number } | null
  readiness: ObservationReadiness
}

// Aggregate a raw fixture-style window (ISO or epoch `at`) into the summary
// plus the newest valid position, applying the same validity rules as the live
// collector.
export function aggregateRawObservationWindow(samples: SailingAverageSample[], now: number): AggregatedObservationWindow {
  const cutoff = now - OBSERVATION_WINDOW_MS
  const inWindow = samples.filter((sample) => Number.isFinite(sample.at) && sample.at >= cutoff && sample.at <= now)
  const averages = aggregateObservationSamples(samples, now)
  let position: { latitude: number; longitude: number } | null = null
  for (const sample of inWindow) {
    if (inRange(sample.latitude, -90, 90) && inRange(sample.longitude, -180, 180) && (now - sample.at) / 1000 <= POSITION_STALE_SECONDS) {
      position = { latitude: sample.latitude, longitude: sample.longitude }
    }
  }
  return { averages, position, readiness: observationReadiness(averages, position) }
}
