import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalJson } from './canonical.mjs'
import { fail } from './diagnostics.mjs'
import { extractSourceFacts } from './extract-source.mjs'
import { extractFreshV2InitialDispatchFacts } from './extractors/fresh-v2-initial-dispatch.mjs'
import { mergeFreshV2InitialDispatchSlice } from './fresh-v2-initial-dispatch-model.mjs'
import { loadKnowledgeGraph } from './load.mjs'
import { buildRegisteredSemanticSlices } from './semantic-slices.mjs'

const same = (left, right) => canonicalJson(left) === canonicalJson(right)

function assertExact(expectedItems, manifestItems, kind) {
  const expected = new Map(expectedItems.map(item => [item.id, item]))
  const actual = new Map(manifestItems.filter(item => item.tags?.includes('kg1-d2') || expected.has(item.id)).map(item => [item.id, item]))
  for (const [id, item] of expected) {
    const candidate = actual.get(id)
    if (candidate === undefined) fail(kind === 'node' ? 'KG_FRESH_V2_NODE_MISSING' : 'KG_FRESH_V2_EDGE_MISSING', `missing KG1-D2 ${kind}: ${id}`)
    if (candidate.classification !== 'reviewed') fail('KG_SEMANTIC_CLASSIFICATION', `${id} must be reviewed`)
    if (!same(item, candidate)) fail(kind === 'node' ? 'KG_FRESH_V2_NODE_DRIFT' : 'KG_FRESH_V2_EDGE_DRIFT', `KG1-D2 ${kind} drifted: ${id}`)
  }
  for (const id of actual.keys()) if (!expected.has(id)) fail(kind === 'node' ? 'KG_FRESH_V2_NODE_EXTRA' : 'KG_FRESH_V2_EDGE_EXTRA', `unexpected KG1-D2 ${kind}: ${id}`)
}

export function reconcileFreshV2InitialDispatchSlice(facts, sourceFacts, manifest) {
  const registered = buildRegisteredSemanticSlices({ freshV2InitialDispatch: facts }, sourceFacts)
  assertExact(registered.nodes, manifest.nodes, 'node')
  assertExact(registered.edges, manifest.edges, 'edge')
  return { sliceId: registered.sliceIds.join(','), sourceDigest: facts.digest, nodeCount: registered.nodes.length, edgeCount: registered.edges.length }
}

export async function buildFreshV2InitialDispatchCandidate(rootInput) {
  const root = resolve(rootInput)
  const sourceFacts = await extractSourceFacts(root)
  const facts = await extractFreshV2InitialDispatchFacts(root)
  const current = JSON.parse(await readFile(resolve(root, 'docs/knowledge-graph/manifest.json'), 'utf8'))
  const registered = buildRegisteredSemanticSlices({ freshV2InitialDispatch: facts }, sourceFacts)
  const slice = registered.slices.find(item => item.sliceId === 'kg1-d2-fresh-v2-initial-dispatch')
  return { facts, sourceFacts, slice, manifest: mergeFreshV2InitialDispatchSlice(current, slice) }
}

async function main() {
  const root = process.cwd()
  const result = await buildFreshV2InitialDispatchCandidate(root)
  if (process.argv.includes('--update')) {
    await writeFile(resolve(root, 'docs/knowledge-graph/manifest.json'), `${canonicalJson(result.manifest)}\n`, 'utf8')
    process.stdout.write(`knowledge graph fresh-v2 semantic slice updated (${result.slice.nodes.length} nodes, ${result.slice.edges.length} edges)\n`)
    return
  }
  const { manifest } = await loadKnowledgeGraph(root, 'docs/knowledge-graph/manifest.json', 'docs/knowledge-graph/schema/manifest.schema.json')
  const summary = reconcileFreshV2InitialDispatchSlice(result.facts, result.sourceFacts, manifest)
  process.stdout.write(`knowledge graph fresh-v2 semantic slice verified (${summary.nodeCount} nodes, ${summary.edgeCount} edges, source ${summary.sourceDigest})\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
