import { describe, expect, it } from 'vitest'
import { publicSessionStats, publicTokenLabel, publicSpeedLabel } from '../src/client/public-session-stats.js'

describe('official session projection statistics', () => {
  it('matches the official pill rounding while preserving exact underlying counts', () => {
    expect(publicTokenLabel(814234, 'K', 'M')).toBe('814K')
    expect(publicTokenLabel(1540, 'K', 'M')).toBe('1.5K')
    expect(publicTokenLabel(1_500_000, 'K', 'M')).toBe('1.5M')
    expect(publicSpeedLabel(29.75)).toBe('30')
    expect(publicSpeedLabel(9.45)).toBe('9.5')
    expect(publicSpeedLabel(undefined)).toBe('—')
  })
  it('sums non-overlapping billed buckets and uses the official cumulative decode denominator', () => {
    const result = publicSessionStats({ tokenUsage: { uncachedInputTokens: 100, cacheReadTokens: 50, cacheWriteTokens: 20, outputTokens: 30, inputTokens: 9999 }, sessionStats: { turns: 3, steps: 8, decodeTokens: 120, decodeMs: 2000 } })
    expect(result.total).toBe(200)
    expect(result.speed).toBe(60)
    expect(result.turns).toBe(3)
  })
  it('keeps absent, malformed, non-finite and zero-duration measurements unknown', () => {
    for (const input of [undefined, {}, { tokenUsage: { uncachedInputTokens: 100 } }, { tokenUsage: { uncachedInputTokens: Infinity, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 2 } }]) expect(publicSessionStats(input).total).toBeUndefined()
    expect(publicSessionStats({ sessionStats: { decodeTokens: 50, decodeMs: 0 } }).speed).toBeUndefined()
    expect(publicSessionStats({ sessionStats: { decodeTokens: -1, decodeMs: 10 } }).speed).toBeUndefined()
  })
})
