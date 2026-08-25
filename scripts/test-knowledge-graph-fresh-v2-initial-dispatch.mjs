import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KnowledgeGraphError } from './knowledge-graph/diagnostics.mjs'
import { extractFreshV2InitialDispatchFacts } from './knowledge-graph/extractors/fresh-v2-initial-dispatch.mjs'
import { buildFreshV2InitialDispatchCandidate, reconcileFreshV2InitialDispatchSlice } from './knowledge-graph/reconcile-fresh-v2-initial-dispatch.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const { facts, sourceFacts, manifest, slice } = await buildFreshV2InitialDispatchCandidate(root)
const summary = reconcileFreshV2InitialDispatchSlice(facts, sourceFacts, manifest)
assert.equal(summary.sliceId, 'kg1-d2-fresh-v2-initial-dispatch')
assert(slice.nodes.some(item => item.id === 'guard:fresh-v2-official-agent-loop-request'))
assert(slice.edges.some(item => item.id === 'edge:fresh-v2/official-permit-guards-enter'))
assert(slice.nodes.some(item => item.id === 'flow:fresh-v2-online-continuation'))
assert(slice.nodes.some(item => item.id === 'transaction:fresh-v2-request-continuation'))
assert(slice.nodes.some(item => item.id === 'flow-branch:fresh-v2-online-continuation/cold-recovery-absent'
  && item.maturity.implementation.state === 'absent'))
assert(slice.edges.some(item => item.id === 'edge:fresh-v2-continuation/service-calls-followup'))
assert(slice.edges.some(item => item.id === 'edge:fresh-v2-continuation/evidence-transitions-running'))
for (const name of facts.absentRecoveryBranches) {
  const branch = slice.nodes.find(item => item.id === `flow-branch:fresh-v2-initial-dispatch/${name}`)
  assert.equal(branch?.maturity.implementation.state, 'absent')
  assert.equal(branch?.maturity.acceptance.state, 'not-candidate')
  assert.equal(branch?.maturity.availability.state, 'unavailable')
}

{
  const candidate = structuredClone(manifest)
  candidate.nodes.find(item => item.id === 'guard:fresh-v2-official-agent-loop-request').security.authoritySource = { id: 'domain:agent-swarm', kind: 'domain' }
  assert.throws(() => reconcileFreshV2InitialDispatchSlice(facts, sourceFacts, candidate), error => error instanceof KnowledgeGraphError && error.code === 'KG_FRESH_V2_NODE_DRIFT')
}

{
  const candidate = structuredClone(manifest)
  candidate.edges = candidate.edges.filter(item => item.id !== 'edge:fresh-v2/evidence-transitions-running')
  assert.throws(() => reconcileFreshV2InitialDispatchSlice(facts, sourceFacts, candidate), error => error instanceof KnowledgeGraphError && error.code === 'KG_FRESH_V2_EDGE_MISSING')
}

{
  const file = 'src/runtime/fresh-v2-initial-runtime.ts'
  const source = await readFile(resolve(root, file), 'utf8')
  await assert.rejects(
    () => extractFreshV2InitialDispatchFacts(root, { sourceOverrides: { [file]: source.replaceAll('options.signal !== permit.signal', 'false') } }),
    error => error instanceof KnowledgeGraphError && error.code === 'KG_FRESH_V2_CONTROL_FLOW',
  )
}

process.stdout.write(`knowledge graph fresh-v2 semantic fixtures PASS (${summary.nodeCount} nodes, ${summary.edgeCount} edges)\n`)
