export const SIGNALK_PATHS = [
  'navigation.position',
  'navigation.speedOverGround',
  'navigation.courseOverGroundTrue',
  'navigation.headingTrue',
  'navigation.headingMagnetic',
  'environment.depth.belowTransducer',
  'environment.wind.speedApparent',
  'environment.wind.angleApparent'
] as const

export type SignalKPath = (typeof SIGNALK_PATHS)[number]
