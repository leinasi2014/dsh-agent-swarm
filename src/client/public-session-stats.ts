const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined

export function publicTokenLabel(value: number | undefined, thousand: string, million: string): string {
  if (value === undefined) return '—'
  if (value < 1000) return String(value)
  const scaled = value < 1_000_000 ? value / 1000 : value / 1_000_000
  return `${scaled >= 100 ? Math.round(scaled) : Math.round(scaled * 10) / 10}${value < 1_000_000 ? thousand : million}`
}
export const publicSpeedLabel = (value: number | undefined): string => value === undefined ? '—' : String(value >= 10 ? Math.round(value) : Math.round(value * 10) / 10)

/** Official tokenUsage/sessionStats projections; no group-message or wall-clock estimate. */
export function publicSessionStats(projection: unknown) {
  const values = record(projection), usage = record(values['tokenUsage']), stats = record(values['sessionStats'])
  const input = count(usage['uncachedInputTokens']), read = count(usage['cacheReadTokens']), write = count(usage['cacheWriteTokens']), output = count(usage['outputTokens'])
  const buckets = [input, read, write, output]
  const total = buckets.every(value => value !== undefined) ? count(buckets.reduce<number>((sum, value) => sum + value!, 0)) : undefined
  const decodeTokens = count(stats['decodeTokens']), decodeMs = count(stats['decodeMs'])
  return { total, input, read, write, output, turns: count(stats['turns']), steps: count(stats['steps']),
    speed: decodeTokens !== undefined && decodeMs !== undefined && decodeMs > 0 ? count(decodeTokens / (decodeMs / 1000)) : undefined,
    llmMs: count(stats['llmMs']), toolMs: count(stats['toolMs']) }
}
