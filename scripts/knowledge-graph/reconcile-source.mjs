import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { canonicalJson } from './canonical.mjs'
import { fail, formatFailure } from './diagnostics.mjs'
import { extractSourceFacts } from './extract-source.mjs'
import { buildMechanicalInventory, mechanicalSignatures } from './inventory-model.mjs'
import { loadKnowledgeGraph } from './load.mjs'

function duplicateIds(items) {
  const seen = new Set()
  return items.map(item => item.id).filter(id => seen.has(id) || !seen.add(id))
}

function assertMapEquality(expected, actual, family) {
  const missing = [...expected.keys()].filter(id => !actual.has(id)).sort()
  if (missing.length > 0) fail(`KG_RECONCILE_${family}_MISSING`, `manifest omits ${family.toLowerCase()} facts`, { ids: missing.slice(0, 64) })
  const extra = [...actual.keys()].filter(id => !expected.has(id)).sort()
  if (extra.length > 0) fail(`KG_RECONCILE_${family}_EXTRA`, `manifest contains source-unbacked ${family.toLowerCase()} facts`, { ids: extra.slice(0, 64) })
  for (const [id, expectedValue] of expected) {
    const actualValue = actual.get(id)
    if (actualValue.kind !== undefined && actualValue.kind !== expectedValue.kind) fail('KG_RECONCILE_KIND', `${id} has kind ${actualValue.kind}; expected ${expectedValue.kind}`)
    if (actualValue.type !== undefined && actualValue.type !== expectedValue.type) fail('KG_RECONCILE_EDGE_TYPE', `${id} has edge type ${actualValue.type}; expected ${expectedValue.type}`)
    if (actualValue.contract !== undefined && actualValue.contract !== expectedValue.contract) fail('KG_RECONCILE_CONTRACT', `${id} contract does not match extracted source facts`)
    for (const key of ['from', 'to']) {
      if (actualValue[key] !== undefined && JSON.stringify(actualValue[key]) !== JSON.stringify(expectedValue[key])) fail('KG_RECONCILE_ENDPOINT', `${id}.${key} does not match extracted source`)
    }
    if (JSON.stringify(actualValue.anchors) !== JSON.stringify(expectedValue.anchors)) fail('KG_RECONCILE_ANCHOR', `${id} anchor does not match extracted source identity`)
    if (actualValue.factAuthority !== undefined && canonicalJson(actualValue.factAuthority) !== canonicalJson(expectedValue.factAuthority)) fail('KG_RECONCILE_FACT_AUTHORITY', `${id}.factAuthority does not match extracted source authority`)
  }
}

export function reconcileSourceManifest(facts, manifest) {
  const nodeDuplicates = duplicateIds(manifest.nodes)
  const edgeDuplicates = duplicateIds(manifest.edges)
  if (nodeDuplicates.length > 0 || edgeDuplicates.length > 0) fail('KG_RECONCILE_DUPLICATE', 'manifest contains duplicate mechanical identities', { nodeDuplicates, edgeDuplicates })
  const expectedManifest = buildMechanicalInventory(facts)
  if (canonicalJson(manifest.project) !== canonicalJson(expectedManifest.project) || canonicalJson(manifest.inventoryPolicy) !== canonicalJson(expectedManifest.inventoryPolicy)) {
    fail('KG_RECONCILE_POLICY', 'manifest project/inventory policy does not match the extracted source inventory')
  }
  const expected = mechanicalSignatures(expectedManifest)
  // Reviewed records are an overlay owned by KG1-D's semantic reconciler. Keep
  // every promoted record whose stable id backs a mechanical source fact, and
  // reject only source-unbacked records that still claim to be mechanical.
  const actual = mechanicalSignatures({
    nodes: manifest.nodes.filter(item => expected.nodes.has(item.id) || item.classification === 'mechanical'),
    edges: manifest.edges.filter(item => expected.edges.has(item.id) || item.classification === 'mechanical'),
  })
  assertMapEquality(expected.nodes, actual.nodes, 'NODE')
  assertMapEquality(expected.edges, actual.edges, 'EDGE')
  return {
    nodeCount: expected.nodes.size,
    edgeCount: expected.edges.size,
    manifestNodeCount: manifest.nodes.length,
    manifestEdgeCount: manifest.edges.length,
  }
}

function parseArgs(argv) {
  const result = { root: fileURLToPath(new URL('../..', import.meta.url)), seed: false, seedOffset: 0, seedLength: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--seed') result.seed = true
    else if (argv[index] === '--seed-offset' && argv[index + 1]) result.seedOffset = Number(argv[++index])
    else if (argv[index] === '--seed-length' && argv[index + 1]) result.seedLength = Number(argv[++index])
    else if (argv[index] === '--root' && argv[index + 1]) result.root = argv[++index]
    else throw new Error(`unknown argument ${JSON.stringify(argv[index])}`)
  }
  if (!Number.isSafeInteger(result.seedOffset) || result.seedOffset < 0 || (result.seedLength !== undefined && (!Number.isSafeInteger(result.seedLength) || result.seedLength < 1))) {
    throw new Error('seed offset/length must be non-negative/positive safe integers')
  }
  return result
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const root = realpathSync(resolve(args.root))
  const facts = await extractSourceFacts(root)
  const sourceErrors = facts.diagnostics.filter(item => item.severity === 'error')
  if (sourceErrors.length > 0) fail('KG_RECONCILE_SOURCE_DIAGNOSTIC', 'source extraction failed', sourceErrors)
  if (args.seed) {
    const seeded = canonicalJson(buildMechanicalInventory(facts))
    process.stdout.write(`${seeded.slice(args.seedOffset, args.seedLength === undefined ? undefined : args.seedOffset + args.seedLength)}\n`)
    return
  }
  const { manifest } = await loadKnowledgeGraph(root, 'docs/knowledge-graph/manifest.json', 'docs/knowledge-graph/schema/manifest.schema.json')
  const summary = reconcileSourceManifest(facts, manifest)
  console.log(`Knowledge graph source/manifest set equality: PASS (${summary.nodeCount} nodes, ${summary.edgeCount} edges)`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try { await main() } catch (error) { console.error(formatFailure(error)); process.exitCode = 1 }
}
