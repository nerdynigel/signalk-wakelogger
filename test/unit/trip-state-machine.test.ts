import { describe, expect, it } from 'vitest'
import { TripStateMachine, distanceMetres } from '../../src/trips/state-machine'

function sample(at: number, lat: number, sogKn: number): any {
  return { capturedAt: at, receivedAt: at, values: { lat, lon: 153, sog_kn: sogKn }, quality: { timestamp: 'source' } }
}
const thresholds = { startSogKn: 1.5, startDistanceM: 200, startDwellMs: 1000, stopSogKn: 0.5, stopRadiusM: 75, stopDwellMs: 2000 }

describe('TripStateMachine', () => {
  it('ignores berth drift, confirms movement, and confirms a sustained stop', () => {
    const machine = new TripStateMachine(undefined, thresholds)
    expect(machine.process(sample(0, -27, 0))).toBeUndefined()
    expect(machine.process(sample(100, -27.0001, 0))).toBeUndefined()
    expect(machine.process(sample(1000, -27.003, 2))?.event).toBe('trip_start_candidate')
    const started = machine.process(sample(2100, -27.004, 3))
    expect(started?.event).toBe('trip_started')
    expect(started?.trackingSessionId).toBeTruthy()
    expect(machine.process(sample(3000, -27.005, 0.1))?.event).toBe('trip_stop_candidate')
    const stopped = machine.process(sample(5100, -27.0051, 0.1))
    expect(stopped?.event).toBe('trip_stopped')
    expect(stopped?.trackingSessionId).toBe(started?.trackingSessionId)
  })

  it('uses geographic distance in metres', () => {
    expect(distanceMetres({ lat: 0, lon: 0 }, { lat: 0.001, lon: 0 })).toBeCloseTo(111.2, 0)
  })

  it('detects a slow marina departure against a stable berth cluster', () => {
    const machine = new TripStateMachine(undefined, { ...thresholds, startDwellMs: 500 })
    machine.process(sample(0, -27, 0))
    for (let step = 1; step <= 3; step += 1) {
      expect(machine.process(sample(step * 100, -27 - step * 0.00045, 0.8))).toBeUndefined()
    }
    expect(machine.process(sample(500, -27.0022, 0.8))?.event).toBe('trip_start_candidate')
    expect(machine.process(sample(1100, -27.0028, 0.8))?.event).toBe('trip_started')
  })
})
