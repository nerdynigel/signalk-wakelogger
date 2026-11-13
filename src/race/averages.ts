import {
  aggregateObservationSamples,
  selectPlanningObservations,
  circularMean,
  OBSERVATION_MAX_AGE_SECONDS,
  OBSERVATION_MIN_SAMPLES,
  OBSERVATION_MIN_SPAN_SECONDS,
  OBSERVATION_WINDOW_MS,
  OBSERVATION_WINDOW_SECONDS,
  observationReadiness,
  type ObservationReadiness,
  type SailingAverageSample,
  type SailingAverages
} from './observation-window'

export type { SailingAverageSample, SailingAverages, ObservationReadiness }
export { OBSERVATION_WINDOW_SECONDS, OBSERVATION_WINDOW_MS, OBSERVATION_MIN_SPAN_SECONDS, OBSERVATION_MIN_SAMPLES, OBSERVATION_MAX_AGE_SECONDS, observationReadiness }

const DEFAULT_WINDOW_MS = OBSERVATION_WINDOW_MS

// Kept for backward-compatible imports; aggregation now lives in
// `observation-window.ts` and is shared with the cloud engine.
export const circularAverage = circularMean

// A bounded rolling store of raw samples. All aggregation (per-sample
// apparent-to-true derivation, mean/circular mean, gust, readiness) is delegated
// to the shared pure `aggregateObservationSamples` so cloud and plugin cannot
// diverge.
export class RollingAverages {
  private samples: SailingAverageSample[] = []
  private firstWindSample: SailingAverageSample | null = null
  private latestWindSample: SailingAverageSample | null = null
  constructor(private readonly windowMs: number = DEFAULT_WINDOW_MS) {}

  add(sample: SailingAverageSample): void {
    if (!Number.isFinite(sample.at)) return
    this.observe(sample)
    this.samples.push(sample)
    this.prune(sample.at)
  }

  value(now: number): SailingAverages | null {
    this.prune(now)
    if (!this.samples.length) return null
    return aggregateObservationSamples(this.samples, now, this.windowMs)
  }

  observe(sample: SailingAverageSample): void {
    if (aggregateObservationSamples([sample], sample.at, this.windowMs).qualifyingSampleCount > 0) {
      this.firstWindSample ??= sample
      this.latestWindSample = sample
    }
  }

  planningValue(now: number): ReturnType<typeof selectPlanningObservations> {
    if (this.firstWindSample && now - this.firstWindSample.at < this.windowMs && this.latestWindSample) {
      return selectPlanningObservations(this.firstWindSample === this.latestWindSample ? [this.latestWindSample] : [this.firstWindSample, this.latestWindSample], now, this.windowMs)
    }
    this.prune(now)
    const samples = this.firstWindSample && !this.samples.includes(this.firstWindSample) ? [this.firstWindSample, ...this.samples] : this.samples
    return selectPlanningObservations(samples, now, this.windowMs)
  }

  reset(): void { this.samples = []; this.firstWindSample = null; this.latestWindSample = null }

  private prune(now: number): void {
    const cutoff = now - this.windowMs
    while (this.samples.length && this.samples[0]!.at < cutoff) this.samples.shift()
  }
}
