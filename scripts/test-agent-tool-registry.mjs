import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { canonicalJson } from './knowledge-graph/canonical.mjs'
import { KnowledgeGraphError } from './knowledge-graph/diagnostics.mjs'
import { extractSourceFacts } from './knowledge-graph/extract-source.mjs'
import {
  AGENT_TOOL_FACETS,
  AGENT_TOOL_FUNCTIONAL_FACETS,
  buildAgentToolRegistryOverlay,
  loadAgentToolRegistry,
  validateAgentToolRegistry,
  validateAgentToolRegistryAgainstFacts,
} from './knowledge-graph/agent-tool-registry.mjs'

const root = realpathSync(resolve(fileURLToPath(new URL('..', import.meta.url))))
const registry = await loadAgentToolRegistry(root)
const facts = await extractSourceFacts(root)
const sourceErrors = facts.diagnostics.filter(item => item.severity === 'error')
if (sourceErrors.length > 0) throw new Error(`source extraction failed: ${JSON.stringify(sourceErrors)}`)

const summary = validateAgentToolRegistryAgainstFacts(registry, facts)
if (summary.toolCount !== 20 || summary.facetCount !== 14 || AGENT_TOOL_FACETS.length !== 13 || AGENT_TOOL_FUNCTIONAL_FACETS.length !== 14) throw new Error('positive closure did not retain 20 tools and 14 functional facets')

function expectCode(label, code, callback) {
  try {
    callback()
    throw new Error(`${label}: expected ${code}`)
  } catch (error) {
    if (!(error instanceof KnowledgeGraphError) || error.code !== code) throw error
  }
}

expectCode('extractor-set-gap', 'KG_TOOL_REGISTRY_SET_MISMATCH', () => {
  const broken = structuredClone(registry)
  broken.entries.pop()
  validateAgentToolRegistryAgainstFacts(broken, facts)
})
expectCode('duplicate-stable-id', 'KG_TOOL_REGISTRY_DUPLICATE_ID', () => {
  const broken = structuredClone(registry)
  broken.entries.splice(1, 0, structuredClone(broken.entries[0]))
  validateAgentToolRegistry(root, broken)
})
expectCode('facet-gap', 'KG_TOOL_REGISTRY_FACETS', () => {
  const broken = structuredClone(registry)
  delete broken.entries[0].recoveryFailure
  validateAgentToolRegistry(root, broken)
})
expectCode('missing-anchor', 'KG_TOOL_REGISTRY_TEST_ANCHOR', () => {
  const broken = structuredClone(registry)
  broken.entries[0].testAnchors = [{ file: 'tests/does-not-exist.spec.ts' }]
  validateAgentToolRegistry(root, broken)
})
expectCode('permission-unclassified', 'KG_TOOL_REGISTRY_PERMISSION', () => {
  const broken = structuredClone(registry)
  broken.entries[0].callerPermissionClass.caller = 'unclassified'
  validateAgentToolRegistry(root, broken)
})
expectCode('false-acceptance', 'KG_TOOL_REGISTRY_FALSE_MATURITY', () => {
  const broken = structuredClone(registry)
  broken.entries[0].maturity.acceptance.state = 'accepted'
  validateAgentToolRegistry(root, broken)
})
expectCode('functional-facet-gap', 'KG_TOOL_REGISTRY_FUNCTIONAL_FACETS', () => {
  const broken = structuredClone(registry)
  delete broken.functionalFacets.ui
  validateAgentToolRegistry(root, broken)
})
expectCode('functional-facet-dangling-tool', 'KG_TOOL_REGISTRY_FUNCTIONAL_FACET_REF', () => {
  const broken = structuredClone(registry)
  broken.functionalFacets.rpc.relatedToolIds = ['tool:agent_swarm_missing']
  validateAgentToolRegistry(root, broken)
})
expectCode('functional-facet-missing-symbol', 'KG_TOOL_REGISTRY_SOURCE_SYMBOL', () => {
  const broken = structuredClone(registry)
  broken.functionalFacets.permission.sourceAnchors[1].symbol = 'TeamPermissionSurface.missingMember'
  validateAgentToolRegistry(root, broken)
})

const first = buildAgentToolRegistryOverlay(registry)
const second = buildAgentToolRegistryOverlay(registry)
if (canonicalJson(first) !== canonicalJson(second)) throw new Error('registry overlay is not deterministic')
for (const entry of registry.entries) {
  for (const type of ['owns', 'guards', 'documented-by']) {
    if (!first.edges.some(edge => edge.type === type && (edge.from === entry.id || edge.to === entry.id))) throw new Error(`${entry.id} is missing ${type} overlay closure`)
  }
  if (entry.testAnchors.length > 0 && !first.edges.some(edge => edge.type === 'test-anchored-by' && edge.from === entry.id)) throw new Error(`${entry.id} is missing test-anchored-by overlay closure`)
  if (entry.testAnchors.length === 0 && !entry.evidenceGaps.includes('NO_DIRECT_TEST')) throw new Error(`${entry.id} hides missing direct test evidence`)
}
if (first.edges.some(edge => edge.type === 'reads' || edge.type === 'mutates' || edge.type === 'verified-by')) throw new Error('registry overlay must not infer state authority or verification from capability metadata')

console.log('Agent tool registry 20-tool/14-functional-facet closure, overlay determinism, and 9 negative cases: PASS')
