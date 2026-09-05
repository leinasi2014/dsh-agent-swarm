/** Private bounded fingerprints and three-state tool-progress detectors. */
import { createHash } from 'node:crypto'

const READS = new Set(['agent_swarm_list_memory', 'agent_swarm_list_private_memory'])
const MAX_ITEMS = 128
const HASH_BUDGET = 65_536

/** Oversized/deep inputs are unknown, never compared by a truncated prefix. */
export function fingerprint(value: unknown): string | undefined {
  const hash = createHash('sha256')
  let remaining = HASH_BUDGET
  let nodes = 4_096
  const feed = (text: string): boolean => {
    if (text.length > remaining) return false
    remaining -= Buffer.byteLength(text)
    if (remaining < 0) return false
    hash.update(text)
    return true
  }
  const visit = (entry: unknown, depth: number): boolean => {
    if (--nodes < 0 || depth > 32) return false
    if (entry === null || typeof entry === 'boolean' || typeof entry === 'number') return feed(JSON.stringify(entry))
    if (typeof entry === 'string') return entry.length <= remaining && feed(JSON.stringify(entry))
    if (typeof entry !== 'object') return false
    if (Array.isArray(entry)) {
      if (entry.length > nodes || !feed('[')) return false
      for (const child of entry) if (!visit(child, depth + 1) || !feed(',')) return false
      return feed(']')
    }
    const keys: string[] = []
    for (const key in entry) {
      if (!Object.hasOwn(entry, key)) continue
      if (keys.length >= nodes || key.length > remaining) return false
      keys.push(key)
    }
    if (!feed('{')) return false
    for (const key of keys.toSorted()) {
      if (!feed(JSON.stringify(key)) || !feed(':') || !visit((entry as Record<string, unknown>)[key], depth + 1) || !feed(',')) return false
    }
    return feed('}')
  }
  return visit(value, 0) ? hash.digest('hex') : undefined
}

export type ToolObservation = {
  request: string | undefined
  name: string | undefined
  read: boolean
  result: string | undefined
  failed: boolean
  unknown: boolean
}
type Recorded = ToolObservation & { noProgress: boolean }
export type GuardNotice = { level: 'WARNING' | 'CRITICAL'; detector: string; count: number }

export function requestIdentity(name: string, args: unknown): Pick<ToolObservation, 'request' | 'name' | 'read'> {
  return { request: fingerprint([name, args]), name: fingerprint(name), read: READS.has(name) }
}

export class ToolProgress {
  private readonly history: Recorded[] = []
  private global = 0
  private unknown = 0
  private generic = 0
  get size(): number { return this.history.length }
  observe(observation: ToolObservation): GuardNotice[] {
    const last = this.history.at(-1)
    const previous = observation.request === undefined ? undefined : this.history.findLast(item => item.request === observation.request)
    const unchanged = observation.result !== undefined && observation.result === previous?.result
    const noProgress = observation.failed || (observation.read && unchanged && previous?.failed === false)
    this.global = noProgress ? this.global + 1 : 0
    this.unknown = observation.unknown && observation.name !== undefined ? (last?.unknown && last.name === observation.name ? this.unknown + 1 : 1) : 0
    this.generic = observation.request !== undefined && observation.result !== undefined
      && last?.request === observation.request && last.result === observation.result ? this.generic + 1 : 1
    this.history.push({ ...observation, noProgress })
    if (this.history.length > MAX_ITEMS) this.history.shift()
    let alternating = 0
    const a = this.history.at(-1)?.request
    const b = this.history.at(-2)?.request
    if (a !== undefined && b !== undefined && a !== b) {
      for (let index = this.history.length - 1; index >= 0; index -= 1) {
        const item = this.history[index]!
        if (!item.noProgress || item.request !== (alternating % 2 === 0 ? a : b)) break
        alternating += 1
      }
    }
    const cycles = Math.floor(alternating / 2)
    const notices: GuardNotice[] = []
    for (const [detector, count, warning, critical] of [
      ['unknown-tool', this.unknown, 5, 10],
      ['ping-pong', cycles, 5, 10],
      ['global', this.global, 20, 30],
      ['generic-repeat', this.generic, 10, Infinity],
    ] as const) {
      if (count === critical) notices.push({ level: 'CRITICAL', detector, count })
      else if (count === warning) notices.push({ level: 'WARNING', detector, count })
    }
    return notices
  }
}
