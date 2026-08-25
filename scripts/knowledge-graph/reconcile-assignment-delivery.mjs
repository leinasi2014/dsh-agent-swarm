import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalJson } from './canonical.mjs'
import { fail } from './diagnostics.mjs'
import { extractSourceFacts } from './extract-source.mjs'
import { extractAssignmentDeliveryFacts } from './extractors/assignment-delivery.mjs'
import {
  mergeAssignmentDeliverySlice,
} from './assignment-delivery-model.mjs'
import { buildRegisteredSemanticSlices } from './semantic-slices.mjs'
import { loadKnowledgeGraph } from './load.mjs'

const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0

function mapById(items) { return new Map(items.map(item => [item.id, item])) }

function same(left, right) {
  if (left === undefined || right === undefined) return left === right
  return canonicalJson(left) === canonicalJson(right)
}

function missingCode(kind, item) {
  if (kind === 'edge') {
    if (item.type === 'verified-by' || item.type === 'documented-by') return 'KG_SEMANTIC_TRACE'
    if (item.type === 'reads' && (item.to.id.startsWith('state-predicate:session-frame-') || item.to.id === 'entity:session-assignment-frame')) return 'KG_SEMANTIC_SESSION_READ'
    if (item.type === 'mutates') return 'KG_SEMANTIC_RECOVERY_MUTATION'
    if (item.type === 'recovers' || item.crash !== undefined) return 'KG_SEMANTIC_RECOVERY'
    return 'KG_SEMANTIC_EDGE_MISSING'
  }
  if (item.kind === 'test' || item.kind === 'document') return 'KG_SEMANTIC_TRACE'
  return 'KG_SEMANTIC_NODE_MISSING'
}

function driftCode(kind, expected, actual) {
  if (kind === 'node') {
    if (!same(expected.ownerAuthority, actual.ownerAuthority)) {
      if (expected.kind === 'official-authority' || expected.ownerAuthority?.kind === 'official-authority') return 'KG_SEMANTIC_AUTHORITY'
      return 'KG_SEMANTIC_OWNER'
    }
    if (!same(expected.security?.authoritySource, actual.security?.authoritySource)) return 'KG_SEMANTIC_AUTHORITY'
    if (expected.kind === 'state-predicate' && !same(expected.contract?.predicate, actual.contract?.predicate)) return 'KG_SEMANTIC_PREDICATE'
    if (!same(expected.security?.guards, actual.security?.guards) || !same(expected.security?.redlines, actual.security?.redlines)) return 'KG_SEMANTIC_GUARD'
    if (!same(expected.bounds, actual.bounds)) return 'KG_SEMANTIC_BOUND'
    if (!same(expected.lifecycle?.disposerOwner, actual.lifecycle?.disposerOwner)) return 'KG_SEMANTIC_DISPOSER'
    if (!same(expected.maturity, actual.maturity)) return 'KG_SEMANTIC_TRACE'
    return 'KG_SEMANTIC_NODE_DRIFT'
  }
  if (expected.crash !== undefined || actual.crash !== undefined) {
    if (expected.crash?.ordinal !== actual.crash?.ordinal) return 'KG_SEMANTIC_ORDINAL'
    if (expected.crash?.retryRule !== actual.crash?.retryRule) return 'KG_SEMANTIC_RETRY'
    if (!same(expected.crash?.recoveryTransactions, actual.crash?.recoveryTransactions) || expected.crash?.recoveryMode !== actual.crash?.recoveryMode) return 'KG_SEMANTIC_RECOVERY'
    if (!same(expected.crash, actual.crash)) return 'KG_SEMANTIC_RECOVERY'
  }
  if (expected.type === 'mutates') return 'KG_SEMANTIC_RECOVERY_MUTATION'
  if (expected.type === 'verified-by' || expected.type === 'documented-by') return 'KG_SEMANTIC_TRACE'
  if (expected.type === 'reads' && (expected.to.id.startsWith('state-predicate:session-frame-') || expected.to.id === 'entity:session-assignment-frame')) return 'KG_SEMANTIC_SESSION_READ'
  return 'KG_SEMANTIC_EDGE_DRIFT'
}

function assertExactFamily(kind, expectedItems, manifestItems) {
  const expected = mapById(expectedItems)
  const actual = mapById(manifestItems)
  for (const [id, item] of expected) {
    const candidate = actual.get(id)
    if (candidate === undefined) fail(missingCode(kind, item), `missing KG1-D1 ${kind} ${id}`, { id })
    if (candidate.classification !== 'reviewed') fail('KG_SEMANTIC_CLASSIFICATION', `${id} must be reviewed`, { id, classification: candidate.classification })
    if (!same(item, candidate)) fail(driftCode(kind, item, candidate), `KG1-D1 ${kind} ${id} drifted`, { id })
  }
  for (const [id, item] of actual) {
    if (!expected.has(id)) fail(kind === 'node' ? 'KG_SEMANTIC_NODE_EXTRA' : 'KG_SEMANTIC_EDGE_EXTRA', `unexpected KG1-D1 ${kind} ${id}`, { id, classification: item.classification })
  }
}

function reviewedItems(manifest, expected) {
  const nodeIds = new Set(expected.nodes.map(item => item.id))
  const edgeIds = new Set(expected.edges.map(item => item.id))
  return {
    nodes: manifest.nodes.filter(item => nodeIds.has(item.id)
      || (item.classification === 'reviewed' && !item.tags?.includes('kg1-d2'))),
    edges: manifest.edges.filter(item => edgeIds.has(item.id)
      || (item.classification === 'reviewed' && !item.id.startsWith('edge:fresh-v2'))),
  }
}

export function reconcileAssignmentDeliverySlice(facts, sourceFacts, manifest) {
  const expected = buildRegisteredSemanticSlices({ assignmentDelivery: facts }, sourceFacts)
  const actual = reviewedItems(manifest, expected)
  assertExactFamily('node', expected.nodes, actual.nodes)
  assertExactFamily('edge', expected.edges, actual.edges)
  return {
    sliceId: expected.sliceIds.join(','),
    sourceDigest: facts.digest,
    nodeCount: expected.nodes.length,
    edgeCount: expected.edges.length,
  }
}

export async function buildAssignmentDeliveryCandidate(rootInput) {
  const root = resolve(rootInput)
  const sourceFacts = await extractSourceFacts(root)
  const facts = await extractAssignmentDeliveryFacts(root)
  const current = JSON.parse(await readFile(resolve(root, 'docs/knowledge-graph/manifest.json'), 'utf8'))
  const registered = buildRegisteredSemanticSlices({ assignmentDelivery: facts }, sourceFacts)
  const slice = registered.slices.find(item => item.sliceId === 'kg1-d1-assignment-delivery-recovery')
  return { facts, sourceFacts, manifest: mergeAssignmentDeliverySlice(current, slice), slice }
}

async function main() {
  const root = process.cwd()
  const candidateMode = process.argv.includes('--candidate')
  const result = await buildAssignmentDeliveryCandidate(root)
  if (process.argv.includes('--update')) {
    await writeFile(resolve(root, 'docs/knowledge-graph/manifest.json'), `${canonicalJson(result.manifest)}\n`, 'utf8')
    process.stdout.write(`knowledge graph assignment-delivery semantic slice updated (${result.slice.nodes.length} nodes, ${result.slice.edges.length} edges)\n`)
    return
  }
  if (candidateMode) {
    const text = `${canonicalJson(result.manifest)}\n`
    if (process.argv.includes('--length-only')) {
      process.stdout.write(String(text.length))
      return
    }
    const offsetFlag = process.argv.indexOf('--offset')
    const lengthFlag = process.argv.indexOf('--length')
    const offset = offsetFlag < 0 ? 0 : Number.parseInt(process.argv[offsetFlag + 1], 10)
    const length = lengthFlag < 0 ? text.length : Number.parseInt(process.argv[lengthFlag + 1], 10)
    process.stdout.write(text.slice(offset, offset + length))
    return
  }
  const { manifest } = await loadKnowledgeGraph(root, 'docs/knowledge-graph/manifest.json', 'docs/knowledge-graph/schema/manifest.schema.json')
  const summary = reconcileAssignmentDeliverySlice(result.facts, result.sourceFacts, manifest)
  process.stdout.write(`knowledge graph assignment-delivery semantic slice verified (${summary.nodeCount} nodes, ${summary.edgeCount} edges, source ${summary.sourceDigest})\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
