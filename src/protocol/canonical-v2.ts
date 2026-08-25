import { createHash } from 'node:crypto'

/** Canonical JSON accepted by the v2 protocol digest helpers. */
export type CanonicalValue = null | boolean | number | string | readonly CanonicalValue[] | {
  readonly [key: string]: CanonicalValue
}

function encode(value: CanonicalValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('canonical v2 numbers must be safe integers')
    return String(value)
  }
  if (Array.isArray(value)) return `[${value.map(item => encode(item)).join(',')}]`
  const record = value as Readonly<Record<string, CanonicalValue>>
  return `{${Object.keys(record).toSorted().map(key => `${JSON.stringify(key)}:${encode(record[key]!)}`).join(',')}}`
}

/** Deterministic UTF-8 representation with sorted object keys. */
export function canonicalV2(value: CanonicalValue): string {
  return encode(value)
}

/** Domain-separated SHA-256 over one canonical protocol value. */
export function canonicalV2Digest(domain: string, value: CanonicalValue): string {
  if (domain.length === 0) throw new TypeError('canonical v2 digest domain must not be empty')
  const hash = createHash('sha256')
  const tag = Buffer.from(domain.normalize('NFC'), 'utf8')
  const body = Buffer.from(canonicalV2(value), 'utf8')
  const length = Buffer.allocUnsafe(4)
  length.writeUInt32BE(tag.length)
  hash.update(length).update(tag)
  length.writeUInt32BE(body.length)
  hash.update(length).update(body)
  return hash.digest('hex')
}

/** Canonical empty/non-empty legacy-manifest set digest from ADR-0009. */
export function legacyManifestSetDigest(digests: readonly string[]): string {
  const ordered = [...new Set(digests)].toSorted()
  if (ordered.length !== digests.length || ordered.some(value => !/^[0-9a-f]{64}$/.test(value))) {
    throw new TypeError('legacy manifest digests must be unique lowercase SHA-256 values')
  }
  return canonicalV2Digest('dsh-agent-swarm/i1b/legacy-set/v1', { count: ordered.length, digests: ordered })
}
