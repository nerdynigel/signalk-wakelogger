import { DEFAULT_PROGRESSION_CONFIG, RaceProgressionDetector, type CourseProgressPoint, type ProgressionConfig, type ProgressionDetection, type ProgressFix } from './detection'
import type { ProgressionAction, ProgressionMode, RaceEvidence, RaceProgressionStore } from './progression-store'

export interface ProgressionCourseState {
  revision: number
  points: CourseProgressPoint[]
  reverse: boolean
  activeIndex: number
  matches: boolean
}

export interface ProgressionServiceOptions {
  store: RaceProgressionStore
  defaultMode: ProgressionMode
  config?: ProgressionConfig
  now?: () => number
}

export class RaceProgressionService {
  private readonly detector: RaceProgressionDetector
  private course: ProgressionCourseState | null = null
  private currentMode: ProgressionMode
  private readonly now: () => number

  constructor(private readonly options: ProgressionServiceOptions) {
    this.currentMode = options.store.mode() ?? options.defaultMode
    this.detector = new RaceProgressionDetector(options.config ?? DEFAULT_PROGRESSION_CONFIG)
    this.now = options.now ?? Date.now
  }

  get mode(): ProgressionMode { return this.currentMode }

  async setMode(mode: ProgressionMode): Promise<void> {
    this.currentMode = mode
    await this.options.store.setMode(mode)
  }

  updateCourse(state: ProgressionCourseState | null): void {
    if (!state || state.points.length < 2) {
      this.course = null
      this.detector.setCourse(0, [], false, 0)
      return
    }
    const revisionChanged = this.course?.revision !== state.revision
    const indexChanged = this.course?.activeIndex !== state.activeIndex
    const reverseChanged = this.course?.reverse !== state.reverse
    this.course = state
    if (revisionChanged || indexChanged || reverseChanged || this.detector.currentRevision !== state.revision) {
      this.detector.setCourse(state.revision, state.points, state.reverse, state.activeIndex)
    }
  }

  fix(fix: ProgressFix): ProgressionDetection | null {
    if (!this.course?.matches) return null
    const detection = this.detector.fix(fix)
    if (!detection) return null
    if (detection.wrongSide) {
      void this.record('wrong_side', detection)
      this.detector.dismiss()
      return detection
    }
    if (this.currentMode === 'off') {
      void this.record('observed', detection)
      this.detector.dismiss()
      return detection
    }
    void this.record('detected', detection)
    return detection
  }

  async resolve(resolution: 'accepted' | 'dismissed', pointIndex: number): Promise<boolean> {
    const pending = this.detector.pendingDetection
    if (!pending || pending.pointIndex !== pointIndex) return false
    const action: ProgressionAction = resolution === 'accepted' ? (this.currentMode === 'auto' ? 'auto_applied' : 'accepted') : 'dismissed'
    await this.record(action, pending)
    if (resolution === 'accepted') this.detector.accept()
    else this.detector.dismiss()
    return true
  }

  status(): object {
    return {
      mode: this.currentMode,
      revision: this.detector.currentRevision,
      activeIndex: this.detector.activeIndex,
      pending: this.detector.pendingDetection,
      lastDetection: this.options.store.latest()?.detection ?? null
    }
  }

  pendingEvents(): RaceEvidence[] { return this.options.store.pending() }

  markPublished(sequences: number[]): Promise<void> { return this.options.store.markPublished(sequences) }

  close(): Promise<void> { return this.options.store.close() }

  private async record(action: ProgressionAction, detection: ProgressionDetection): Promise<void> {
    await this.options.store.append(action, this.currentMode, detection, this.now())
  }
}