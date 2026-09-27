// Exact browser port of the shared apparent-to-true derivation used by the
// onboard planner (`src/race/observation-window.ts` `deriveTrueWindSample`).
// Keeping one algorithm here avoids a second, unverified wind calculation in
// the browser; parity is proven by a unit test that runs both implementations
// over the same inputs.
//
// Model (identical to the cloud/plugin engine):
//  - direct true wind when valid TWS/TWD are present;
//  - otherwise derive from apparent wind, preferring the ground vector
//    (COG + SOG) and falling back to the water vector (heading + STW);
//  - never fabricate a value from missing instruments.
export function normalizeDegrees(value) {
  return ((value % 360) + 360) % 360
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function inRange(value, min, max) {
  return finite(value) && value >= min && value <= max
}

export function deriveTrueWindSample(sample) {
  if (inRange(sample.twsKnots, 0, 200) && inRange(sample.twdDeg, 0, 360)) {
    return { twsKnots: sample.twsKnots, twdDeg: normalizeDegrees(sample.twdDeg), direct: true }
  }
  if (!inRange(sample.awsKnots, 0, 120) || sample.awsKnots <= 0) return null
  const heading = finite(sample.headingDeg) ? sample.headingDeg : null
  const cog = finite(sample.cogDeg) ? sample.cogDeg : null
  if (heading === null && cog === null) return null
  const sog = inRange(sample.sogKnots, 0, 80) ? sample.sogKnots : null
  const stw = inRange(sample.stwKnots, 0, 80) ? sample.stwKnots : null
  let boatReference
  let boatSpeed
  if (sog !== null) {
    boatReference = cog ?? heading
    boatSpeed = sog
  } else if (stw !== null) {
    boatReference = heading ?? cog
    boatSpeed = stw
  } else {
    return null
  }
  let apparentFromDeg = null
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
