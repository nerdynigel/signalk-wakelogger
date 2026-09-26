import { describe, expect, it } from 'vitest'
import { MAX_PACK_BYTES, MAX_FORECAST_SAMPLES_TOTAL, parseRacePack } from '../../src/race/pack'
import { RACE_PACK_LIMITS } from '../../src/race/race-pack-protocol'
import { makeStressPack, measurePack } from '../helpers/race-pack'

describe('race pack size bounds', () => {
  it('measures a realistic large pack and stays within the configured bounds', () => {
    const pack = makeStressPack()
    const bytes = Buffer.from(JSON.stringify(pack), 'utf8')
    const sizes = measurePack(pack, RACE_PACK_LIMITS.maxChunkChars)
    console.log(`stress pack sizes: ${JSON.stringify({ ...sizes, limits: { maxUncompressedBytes: RACE_PACK_LIMITS.maxUncompressedBytes, maxCompressedBytes: RACE_PACK_LIMITS.maxCompressedBytes, maxChunks: RACE_PACK_LIMITS.maxChunks, maxChunkChars: RACE_PACK_LIMITS.maxChunkChars } })}`)
    const parsed = parseRacePack(bytes)
    expect(parsed.course.points).toHaveLength(12)
    expect(parsed.forecast.legs).toHaveLength(11)
    expect(parsed.forecast.legs.every((leg) => leg.samples.length === 96)).toBe(true)
    expect(parsed.forecast.legs.reduce((sum, leg) => sum + leg.samples.length, 0)).toBeLessThan(MAX_FORECAST_SAMPLES_TOTAL)
    expect(sizes.uncompressedBytes).toBeLessThanOrEqual(RACE_PACK_LIMITS.maxUncompressedBytes)
    expect(sizes.gzipBytes).toBeLessThanOrEqual(RACE_PACK_LIMITS.maxCompressedBytes)
    expect(sizes.chunksRequired).toBeLessThanOrEqual(RACE_PACK_LIMITS.maxChunks)
    expect(MAX_PACK_BYTES).toBe(RACE_PACK_LIMITS.maxUncompressedBytes)
  })
})
