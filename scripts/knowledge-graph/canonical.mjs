import { createHash } from 'node:crypto'
import canonicalize from 'canonicalize'
import { fail } from './diagnostics.mjs'

export const GRAPH_DIGEST_TAG = 'dsh-agent-swarm/knowledge-graph/v1'

export function canonicalJson(value) {
  const result = canonicalize(value)
  if (typeof result !== 'string') fail('KG_JCS_UNSUPPORTED', 'value cannot be represented by RFC 8785 JCS')
  return result
}

export function taggedSha256(tag, value) {
  return createHash('sha256')
    .update(tag, 'utf8')
    .update(Buffer.from([0]))
    .update(canonicalJson(value), 'utf8')
    .digest('hex')
}

export function graphDigest(manifest) {
  return taggedSha256(GRAPH_DIGEST_TAG, manifest)
}
