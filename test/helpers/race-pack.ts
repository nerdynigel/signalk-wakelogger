import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { MAX_PACK_BYTES } from '../../src/race/pack'

export interface FixturePoint {
  id?: string
  name: string
  latitude: number
  longitude: number
  kind?: string
  rounding?: string
}

export interface FixtureForecastSample {
  time: string
  twd_deg: number
  tws_knots: number
  gust_knots?: number | null
  wave_height_m?: number | null
  wave_direction_deg?: number | null
  current_velocity_kn?: number | null
  current_direction_deg?: number | null
}

export interface FixturePack {
  v: 1
  kind: 'race_pack'
  packId?: string | null
  revision: number
  racePlanId?: number | null
  generatedAt: string
  validFrom?: string | null
  validUntil?: string | null
  ruleSetVersion: string
  course: { courseId: string; racePlanId?: number | null; name: string; points: FixturePoint[] }
  sails: Array<Record<string, unknown>>
  raceHeadsail?: { sail_id: number; sail_name?: string | null } | null
  payload: Record<string, unknown>
  forecast: { snapshot?: Record<string, unknown> | null; coverage?: { from: string; until: string } | null; legs: Array<{ sequence: number; latitude?: number | null; longitude?: number | null; samples: FixtureForecastSample[] }> }
  polarSummary?: Record<string, unknown> | null
}

export const RACE_PACK_POINTS: FixturePoint[] = [
  { id: 'start', name: 'Race start', latitude: -27.4, longitude: 153.17, kind: 'start', rounding: 'either' },
  { id: 'mark-1', name: 'Eastern mark', latitude: -27.39, longitude: 153.17, kind: 'mark', rounding: 'starboard' },
  { id: 'finish', name: 'Race finish', latitude: -27.39, longitude: 153.19, kind: 'finish', rounding: 'either' }
]

export function sailFixture(id: number, name: string, type: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, sail_name: name, sail_type: type, availability_status: 'Available', is_available: true, archived_at: null,
    max_aws_knots: null, min_awa_deg: null, max_awa_deg: null, min_twa_deg: null, max_twa_deg: null,
    min_tws_knots: null, max_tws_knots: null, crew_required: null,
    reef_1_tws_knots: null, reef_2_tws_knots: null, reef_3_tws_knots: null, ...extra
  }
}

function hourSample(hour: number, twd: number, tws: number): FixtureForecastSample {
  return {
    time: `2026-09-17T${String(hour).padStart(2, '0')}:00:00Z`,
    twd_deg: twd, tws_knots: tws, gust_knots: tws + 4,
    wave_height_m: 0.6, wave_direction_deg: twd, current_velocity_kn: 0.4, current_direction_deg: 200
  }
}

export function makeFixturePack(overrides: Partial<FixturePack> = {}): FixturePack {
  return {
    v: 1,
    kind: 'race_pack',
    packId: 'pack-42-1',
    revision: 4,
    racePlanId: 42,
    generatedAt: '2026-09-17T01:00:00Z',
    validFrom: '2020-01-01T00:00:00Z',
    validUntil: '2035-01-01T00:00:00Z',
    ruleSetVersion: 'race_plan_dynamic_v1',
    course: { courseId: 'race-42', racePlanId: 42, name: 'Saturday bay race', points: RACE_PACK_POINTS.map((point) => ({ ...point })) },
    sails: [
      sailFixture(1, 'Doyle main', 'Mainsail', { min_twa_deg: 0, max_twa_deg: 180, min_tws_knots: 0, max_tws_knots: 25, crew_required: 1 }),
      sailFixture(3, 'No. 3 jib', 'No. 3 jib', { min_awa_deg: 0, max_awa_deg: 90, min_twa_deg: 0, max_twa_deg: 110, min_tws_knots: 8, max_tws_knots: 25, crew_required: 1 }),
      sailFixture(5, 'A2 kite', 'Asymmetric A2', { min_awa_deg: 60, max_awa_deg: 160, min_twa_deg: 70, max_twa_deg: 180, min_tws_knots: 6, max_tws_knots: 22, crew_required: 3 })
    ],
    raceHeadsail: null,
    payload: { startTime: '2026-09-17T02:00:00Z', availableCrewCount: 3, jibChangesAllowed: false },
    forecast: {
      snapshot: { provider: 'example-model', runAt: '2026-09-16T18:00:00Z', fetchedAt: '2026-09-16T18:30:00Z' },
      coverage: { from: '2026-09-17T02:00:00Z', until: '2026-09-17T04:00:00Z' },
      legs: [
        { sequence: 1, latitude: -27.395, longitude: 153.17, samples: [hourSample(2, 45, 14), hourSample(3, 60, 13), hourSample(4, 75, 12)] },
        { sequence: 2, latitude: -27.39, longitude: 153.18, samples: [hourSample(2, 90, 12), hourSample(3, 100, 11), hourSample(4, 110, 10)] }
      ]
    },
    polarSummary: { eligible: false },
    ...overrides
  }
}

// Long offshore course with a full multi-day, hourly forecast window per leg.
// Used to measure realistic large-pack sizes and to prove the bounds have
// headroom.
export function makeStressPack(): FixturePack {
  const points: FixturePoint[] = [{ id: 'p0', name: 'Start', latitude: -27.4, longitude: 153.17, kind: 'start', rounding: 'either' }]
  for (let index = 1; index <= 11; index += 1) {
    points.push({ id: `p${index}`, name: `Mark ${index}`, latitude: -27.4 - index * 0.12, longitude: 153.17 + index * 0.18, kind: index === 11 ? 'finish' : 'mark', rounding: index % 2 === 0 ? 'starboard' : 'port' })
  }
  const sails = [sailFixture(1, 'Offshore main', 'Mainsail', { min_twa_deg: 0, max_twa_deg: 180, min_tws_knots: 0, max_tws_knots: 35, crew_required: 2 })]
  for (let index = 2; index <= 31; index += 1) {
    sails.push(sailFixture(index, `Sail ${index}`, index % 3 === 0 ? `No. ${(index % 4) + 1} jib` : index % 3 === 1 ? `Code ${index}` : `A${index % 6} asymmetric`, { min_tws_knots: index % 25, max_tws_knots: 10 + (index % 25), min_twa_deg: 0, max_twa_deg: 180, crew_required: (index % 4) + 1 }))
  }
  const legs = points.slice(1).map((point, legIndex) => {
    const samples: FixtureForecastSample[] = []
    for (let hour = 0; hour < 96; hour += 1) {
      samples.push({
        time: new Date(Date.UTC(2026, 8, 17) + hour * 3_600_000).toISOString(),
        twd_deg: (40 + hour * 2 + legIndex * 15) % 360,
        tws_knots: 8 + ((hour + legIndex * 3) % 22),
        gust_knots: 12 + ((hour + legIndex * 3) % 24),
        wave_height_m: Math.round((0.3 + ((hour + legIndex) % 20) / 10) * 10) / 10,
        wave_direction_deg: (40 + hour * 2 + legIndex * 15) % 360,
        current_velocity_kn: Math.round(((hour % 7) / 10) * 10) / 10,
        current_direction_deg: (200 + hour) % 360
      })
    }
    return { sequence: legIndex + 1, latitude: point.latitude, longitude: point.longitude, samples }
  })
  return makeFixturePack({
    packId: 'pack-stress-1',
    revision: 1,
    racePlanId: 9001,
    validFrom: new Date(Date.UTC(2026, 8, 16)).toISOString(),
    validUntil: new Date(Date.UTC(2026, 8, 22)).toISOString(),
    course: { courseId: 'race-stress', racePlanId: 9001, name: 'Long offshore', points },
    sails,
    raceHeadsail: { sail_id: 3, sail_name: 'No. 2 jib' },
    payload: { startTime: new Date(Date.UTC(2026, 8, 17)).toISOString(), availableCrewCount: 6, jibChangesAllowed: false },
    forecast: { snapshot: { provider: 'example-model', runAt: new Date(Date.UTC(2026, 8, 16, 18)).toISOString(), fetchedAt: new Date(Date.UTC(2026, 8, 16, 18, 30)).toISOString() }, coverage: { from: new Date(Date.UTC(2026, 8, 17, 0)).toISOString(), until: new Date(Date.UTC(2026, 8, 20, 23)).toISOString() }, legs },
    polarSummary: { eligible: true, buckets: Array.from({ length: 80 }, (_, index) => ({ abs_twa_deg: 40 + (index % 10) * 10, tws_kn: 6 + Math.floor(index / 10) * 3, average_speed_kn: 4 + (index % 6), sample_count: 12, side: index % 2 === 0 ? 'starboard' : 'port' })) }
  })
}

export interface EncodedPack {
  manifest: Record<string, unknown>
  chunkCount: number
  chunkPayloads: Buffer[]
  manifestPayload: Buffer
  canonicalBytes: Buffer
  sha256: string
  gzipBytes: Buffer
  base64: string
}

export function encodeFixturePack(pack: FixturePack, options: { chunkCount?: number; packId?: string; revision?: number } = {}): EncodedPack {
  const canonicalBytes = Buffer.from(JSON.stringify(pack), 'utf8')
  const sha256 = createHash('sha256').update(canonicalBytes).digest('hex')
  const gzipBytes = gzipSync(canonicalBytes)
  const base64 = gzipBytes.toString('base64')
  const groups = base64.match(/.{1,4}/g) ?? []
  const requested = Math.max(1, options.chunkCount ?? 2)
  const per = Math.max(1, Math.ceil(groups.length / requested))
  const parts: string[] = []
  for (let index = 0; index < requested; index += 1) parts.push(groups.slice(index * per, (index + 1) * per).join(''))
  const chunkCount = parts.length
  const packId = options.packId ?? (pack.packId as string) ?? 'pack'
  const revision = options.revision ?? pack.revision
  const manifest = {
    v: 1, packId, revision,
    racePlanId: pack.racePlanId ?? null,
    generatedAt: pack.generatedAt,
    validFrom: pack.validFrom ?? null,
    validUntil: pack.validUntil ?? null,
    ruleSetVersion: pack.ruleSetVersion,
    encoding: 'gzip+base64',
    chunkCount,
    sha256
  }
  const chunkPayloads = parts.map((data, index) => Buffer.from(JSON.stringify({ v: 1, packId, revision, index, chunkCount, data }), 'utf8'))
  return { manifest, chunkCount, chunkPayloads, manifestPayload: Buffer.from(JSON.stringify(manifest), 'utf8'), canonicalBytes, sha256, gzipBytes, base64 }
}

export interface PackSizes {
  uncompressedBytes: number
  gzipBytes: number
  base64Chars: number
  chunksRequired: number
}

export function measurePack(pack: FixturePack, maxChunkChars = 48 * 1024): PackSizes {
  const canonical = Buffer.byteLength(JSON.stringify(pack), 'utf8')
  const gzip = gzipSync(Buffer.from(JSON.stringify(pack), 'utf8'))
  const base64 = gzip.toString('base64')
  return { uncompressedBytes: canonical, gzipBytes: gzip.length, base64Chars: base64.length, chunksRequired: Math.ceil(base64.length / maxChunkChars) }
}

export const STRESS_PACK_UNCOMPRESSED_LIMIT = MAX_PACK_BYTES
