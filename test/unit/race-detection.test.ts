import { describe, expect, it } from 'vitest'
import { DEFAULT_PROGRESSION_CONFIG, RaceProgressionDetector, type CourseProgressPoint, type ProgressFix } from '../../src/race/detection'

const START = { latitude: -27.45, longitude: 153.05 }
const MARK = offset(START, 500, 0)
const FINISH = offset(MARK, 0, 500)

function offset(origin: { latitude: number; longitude: number }, northM: number, eastM: number) {
  return {
    latitude: origin.latitude + northM / 111_320,
    longitude: origin.longitude + eastM / (111_320 * Math.cos(origin.latitude * Math.PI / 180))
  }
}

function course(): CourseProgressPoint[] {
  return [
    { ...START, kind: 'start' },
    { ...MARK, kind: 'mark', rounding: 'starboard' },
    { ...FINISH, kind: 'finish' }
  ]
}

function path(from: { latitude: number; longitude: number }, to: { latitude: number; longitude: number }, steps: number): ProgressFix[] {
  const fixes: ProgressFix[] = []
  for (let index = 0; index <= steps; index += 1) {
    const ratio = index / steps
    fixes.push({
      at: 1_000_000 + index * 1000,
      latitude: from.latitude + (to.latitude - from.latitude) * ratio,
      longitude: from.longitude + (to.longitude - from.longitude) * ratio,
      sogKn: 4
    })
  }
  return fixes
}

function run(detector: RaceProgressionDetector, fixes: ProgressFix[]) {
  let detection = null
  for (const fix of fixes) detection = detector.fix(fix) ?? detection
  return detection
}

describe('race progression detection', () => {
  it('detects a clean starboard rounding on the correct side', () => {
    const detector = new RaceProgressionDetector({ ...DEFAULT_PROGRESSION_CONFIG })
    detector.setCourse(7, course(), false, 1)
    const track = path(offset(MARK, -200, -20), offset(MARK, 200, -20), 40)
    const detection = run(detector, track)
    expect(detection).toMatchObject({ type: 'rounding', pointIndex: 1, wrongSide: false, passedSide: 'starboard', confidence: 'high', revision: 7 })
    expect(detection?.at).toBeGreaterThan(track[0]!.at)
    expect(detection?.distanceM).toBeLessThanOrEqual(75)
  })

  it('marks a wrong-side pass without advancing confidence', () => {
    const detector = new RaceProgressionDetector({ ...DEFAULT_PROGRESSION_CONFIG })
    detector.setCourse(1, course(), false, 1)
    const detection = run(detector, path(offset(MARK, -200, 35), offset(MARK, 200, 35), 40))
    expect(detection).toMatchObject({ pointIndex: 1, wrongSide: true, passedSide: 'port', confidence: 'medium' })
  })

  it('accepts a port rounding on the correct side', () => {
    const points = course()
    points[1]!.rounding = 'port'
    const detector = new RaceProgressionDetector({ ...DEFAULT_PROGRESSION_CONFIG })
    detector.setCourse(2, points, false, 1)
    const detection = run(detector, path(offset(MARK, -200, 35), offset(MARK, 200, 35), 40))
    expect(detection).toMatchObject({ wrongSide: false, passedSide: 'port', confidence: 'high' })
  })

  it('ignores line crossings outside the capture radius', () => {
    const detector = new RaceProgressionDetector({ ...DEFAULT_PROGRESSION_CONFIG })
    detector.setCourse(1, course(), false, 1)
    expect(run(detector, path(offset(MARK, -200, -200), offset(MARK, 200, -200), 40))).toBeNull()
  })

  it('ignores drift below the minimum speed and missing or poor fixes', () => {
    const detector = new RaceProgressionDetector({ ...DEFAULT_PROGRESSION_CONFIG })
    detector.setCourse(1, course(), false, 1)
    const slow = path(offset(MARK, -200, -20), offset(MARK, 200, -20), 40).map((fix) => ({ ...fix, sogKn: 0.4 }))
    expect(run(detector, slow)).toBeNull()

    const missing = path(offset(MARK, -200, -20), offset(MARK, 200, -20), 40).map((fix) => ({ ...fix, sogKn: null }))
    expect(run(detector, missing)).toBeNull()

    const inaccurate = path(offset(MARK, -200, -20), offset(MARK, 200, -20), 40).map((fix) => ({ ...fix, accuracyM: 80 }))
    expect(run(detector, inaccurate)).toBeNull()
  })

  it('detects start and finish crossings only in the course direction', () => {
    const detector = new RaceProgressionDetector({ ...DEFAULT_PROGRESSION_CONFIG })
    detector.setCourse(3, course(), false, 0)
    const start = run(detector, path(offset(START, -200, 20), offset(START, 200, 20), 40))
    expect(start).toMatchObject({ type: 'start', pointIndex: 0 })

    const wrongWay = new RaceProgressionDetector({ ...DEFAULT_PROGRESSION_CONFIG })
    wrongWay.setCourse(3, course(), false, 0)
    expect(run(wrongWay, path(offset(START, 200, 20), offset(START, -200, 20), 40))).toBeNull()

    const finish = new RaceProgressionDetector({ ...DEFAULT_PROGRESSION_CONFIG })
    finish.setCourse(3, course(), false, 2)
    const finished = run(finish, path(offset(FINISH, 20, -200), offset(FINISH, 20, 200), 40))
    expect(finished).toMatchObject({ type: 'finish', pointIndex: 2 })
  })

  it('emits once per point and only advances through accept or a new index', () => {
    const detector = new RaceProgressionDetector({ ...DEFAULT_PROGRESSION_CONFIG })
    detector.setCourse(1, course(), false, 1)
    const track = path(offset(MARK, -200, -20), offset(MARK, 200, -20), 40)
    const detection = run(detector, track)
    expect(detection).not.toBeNull()
    expect(detector.fix({ at: track.at(-1)!.at + 1000, latitude: track.at(-1)!.latitude + 0.0001, longitude: track.at(-1)!.longitude, sogKn: 4 })).toBeNull()

    detector.accept()
    expect(detector.activeIndex).toBe(2)
    const finished = run(detector, path(offset(FINISH, 20, -200), offset(FINISH, 20, 200), 40))
    expect(finished).toMatchObject({ type: 'finish' })

    detector.setActiveIndex(1)
    const again = run(detector, track)
    expect(again).toMatchObject({ pointIndex: 1 })
  })

  it('re-arms after a dismissed detection only on a fresh crossing', () => {
    const detector = new RaceProgressionDetector({ ...DEFAULT_PROGRESSION_CONFIG })
    detector.setCourse(1, course(), false, 1)
    const outbound = path(offset(MARK, -200, -20), offset(MARK, 200, -20), 40)
    expect(run(detector, outbound)).not.toBeNull()
    detector.dismiss()
    const continuing = path(offset(MARK, 200, -20), offset(MARK, 400, -20), 10)
    expect(run(detector, continuing)).toBeNull()

    const back = path(offset(MARK, 400, -20), offset(MARK, -200, -20), 60)
    expect(run(detector, back)).toBeNull()
    const recross = path(offset(MARK, -200, -20), offset(MARK, 200, -20), 40)
    expect(run(detector, recross)).not.toBeNull()
  })

  it('maps reversed courses and flips rounding sides', () => {
    const detector = new RaceProgressionDetector({ ...DEFAULT_PROGRESSION_CONFIG })
    detector.setCourse(4, course(), true, 1)
    expect(detector.activeIndex).toBe(1)
    const detection = run(detector, path(offset(MARK, 20, 200), offset(MARK, 20, -200), 40))
    expect(detection).toMatchObject({ pointIndex: 1, passedSide: 'port', wrongSide: false })
  })
})