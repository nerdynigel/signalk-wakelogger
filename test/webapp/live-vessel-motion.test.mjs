import test from 'node:test'
import assert from 'node:assert/strict'
import { LiveVesselMotion, outsideFollowArea } from '../../webapp/live-vessel-motion.mjs'
const now = 1800000000000
const fix = (lat = -27, at = now, sequence = 1, headingDeg = 350, longitude = 153) => ({ latitude: lat, longitude, headingDeg, capturedAt: new Date(at).toISOString(), sequence })
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`)
test('interpolates between measured fixes and stops at the last received position', () => {
  const m = new LiveVesselMotion(), raw = fix(-26.9999, now + 1000, 2, 10), before = structuredClone(raw)
  m.update('trip', fix(), now)
  m.update('trip', raw, now + 1000)
  const half = m.sample(now + 1500)
  close(half.latitude, -26.99995)
  close(half.headingDeg, 0)
  close(m.sample(now + 30000).latitude, raw.latitude)
  assert.deepEqual(raw, before)
  assert.equal(m.moving(now + 2000), false)
})
test('retargets from the position on screen without snapping or restarting duplicates', () => {
  const m = new LiveVesselMotion()
  m.update('trip', fix(), now)
  m.update('trip', fix(-26.9998, now + 2000, 2), now + 2000)
  const shown = m.sample(now + 2500)
  assert.equal(m.update('trip', fix(-26.9998, now + 2000, 2), now + 2500), false)
  m.update('trip', fix(-26.9997, now + 3000, 3), now + 3000)
  close(m.sample(now + 3000).latitude, -26.9999)
  assert.ok(shown.latitude < m.sample(now + 3000).latitude)
})
test('rejects stale, future, out-of-order, invalid and impossible GPS fixes', () => {
  const m = new LiveVesselMotion()
  m.update('trip', fix(), now)
  for (const f of [fix(-10, now + 1000, 2), fix(-27, now - 1, 2), fix(-27, now + 1000, 0),
    fix(-27, now - 31000, 3), fix(-27, now + 5000, 3), { ...fix(), latitude: null }, { ...fix(), longitude: 181 }]) {
    assert.equal(m.update('trip', f, now + 1000), false)
    close(m.sample(now + 2000).latitude, -27)
  }
  assert.equal(m.update('trip', fix(-26.9999, now + 2000, 3), now + 2000), true)
})
test('session changes, reconnects and reduced motion start at the accepted fix', () => {
  const m = new LiveVesselMotion()
  m.update('a', fix(), now)
  m.update('b', fix(-28, now + 1000, 1), now + 1000)
  close(m.sample(now + 1000).latitude, -28)
  m.update('b', fix(-26, now + 20000, 2), now + 20000)
  close(m.sample(now + 20000).latitude, -26)
  m.update('b', fix(-25.9999, now + 21000, 3), now + 21000, true)
  close(m.sample(now + 21000).latitude, -25.9999)
})
test('crosses the date line using the short longitude arc', () => {
  const m = new LiveVesselMotion()
  m.update('trip', fix(0, now, 1, 10, 179.9999), now)
  m.update('trip', fix(0, now + 1000, 2, 350, -179.9999), now + 1000)
  close(Math.abs(m.sample(now + 1500).longitude), 180)
  close(m.sample(now + 1500).headingDeg, 0)
})
test('camera follow tolerates movement within the central area', () => {
  const desired = { x: 400, y: 300 }
  assert.equal(outsideFollowArea({ x: 450, y: 330 }, desired, 800, 600), false)
  assert.equal(outsideFollowArea({ x: 481, y: 300 }, desired, 800, 600), true)
  assert.equal(outsideFollowArea({ x: 400, y: 373 }, desired, 800, 600), true)
})

test('gentle camera follow warms up on three distinct fixes and filters course jitter', () => {
  const m = new LiveVesselMotion()
  m.update('trip', { ...fix(), courseDeg: 359 }, now)
  m.update('trip', { ...fix(), courseDeg: 359 }, now + 100)
  assert.equal(m.fixCount, 1)
  m.update('trip', { ...fix(-26.99999, now + 1000, 2), courseDeg: 0 }, now + 1000)
  assert.equal(m.fixCount, 2)
  assert.equal(m.followPose().ready, false)
  close(m.followPose().headingDeg, 350)
  close(m.followHeadingDeg, 359)
  m.update('trip', { ...fix(-26.99998, now + 2000, 3), courseDeg: 5 }, now + 2000)
  assert.equal(m.fixCount, 3)
  assert.equal(m.followPose().ready, true)
  assert.ok(m.followPose().headingDeg < 1)
  assert.ok(m.followHeadingDeg < 1) // Short arc through north, not a map swing.
  m.update('new-trip', fix(-28, now + 3000, 1), now + 3000)
  assert.equal(m.fixCount, 1)
})
