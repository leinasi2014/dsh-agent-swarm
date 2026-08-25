import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { KnowledgeGraphError } from './knowledge-graph/diagnostics.mjs'
import { extractSourceFacts } from './knowledge-graph/extract-source.mjs'
import { loadKnowledgeGraph } from './knowledge-graph/load.mjs'
import { reconcileSourceManifest } from './knowledge-graph/reconcile-source.mjs'
import { buildMechanicalInventory } from './knowledge-graph/inventory-model.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const facts = await extractSourceFacts(root)
const { manifest } = await loadKnowledgeGraph(root, 'docs/knowledge-graph/manifest.json', 'docs/knowledge-graph/schema/manifest.schema.json')

function expectCode(code, mutate) {
  const candidate = structuredClone(manifest)
  mutate(candidate)
  assert.throws(() => reconcileSourceManifest(facts, candidate), error => error instanceof KnowledgeGraphError && error.code === code)
}

function expectFactsCode(code, mutate) {
  const candidateFacts = structuredClone(facts)
  mutate(candidateFacts)
  assert.throws(() => reconcileSourceManifest(candidateFacts, manifest), error => error instanceof KnowledgeGraphError && error.code === code)
}

function expectSourceCollision(mutate, expectedNodeFragment) {
  const candidateFacts = structuredClone(facts)
  mutate(candidateFacts)
  assert.throws(() => buildMechanicalInventory(candidateFacts), error => {
    assert(error instanceof KnowledgeGraphError)
    assert.equal(error.code, 'KG_RECONCILE_SOURCE_ID_COLLISION')
    assert(Array.isArray(error.details?.nodeIds) && Array.isArray(error.details?.edgeIds))
    assert(error.details.nodeIds.some(id => id.includes(expectedNodeFragment)))
    return true
  })
}

assert.deepEqual({
  modules: facts.modules.length,
  imports: facts.modules.reduce((sum, item) => sum + item.imports.length, 0),
  packageExports: facts.packageExports.length,
  tools: facts.tools.length,
  injections: facts.injections.length,
  registries: facts.registries.length,
  builtins: facts.registries.flatMap(item => item.builtins).length,
  extensions: facts.registryExtensions.length,
  facades: facts.registryFacades.length,
  providerCalls: facts.providerRegistrations.length,
  registryMethods: facts.providerRegistryMethods.length,
  config: facts.config.schema.properties.length,
  effectiveConfig: facts.config.effectiveConsumptions.length,
  domains: facts.domains.length,
  domainPort: facts.teamDomainPort.methods.length,
  stateUnions: facts.stateUnions.length,
  discriminants: facts.entityDiscriminants.length,
  rpcRoutes: facts.rpc.routes.length,
  rpcMethods: facts.rpc.methods.values.length,
  rpcSchemas: facts.rpc.schemas.length,
  rpcCapabilities: facts.rpc.capabilities.length,
  rpcRuntimeCapabilities: facts.rpc.runtimeCapabilities.length,
  rpcBounds: facts.rpc.bounds.length,
  clientEntrypoints: facts.client.entrypoints.length,
  clientSlots: facts.client.slots.length,
  listeners: facts.lifecycle.listeners.length,
  effects: facts.lifecycle.effects.length,
  systemPrompts: facts.lifecycle.systemPrompts.length,
  reexportLayers: facts.reexportLayers.length,
  reachableRootExports: facts.reachableRootExports.length,
  reachablePublicApiExports: facts.reachablePublicApiExports.length,
}, {
  modules: 128, imports: 746, packageExports: 6, tools: 20, injections: 34,
  registries: 7, builtins: 15, extensions: 7, facades: 4, providerCalls: 6, registryMethods: 11,
  config: 43, effectiveConfig: 97, domains: 4, domainPort: 30, stateUnions: 14, discriminants: 46,
  rpcRoutes: 1, rpcMethods: 5, rpcSchemas: 23, rpcCapabilities: 3, rpcRuntimeCapabilities: 1, rpcBounds: 5,
  clientEntrypoints: 2, clientSlots: 6, listeners: 27, effects: 30, systemPrompts: 1,
  reexportLayers: 67, reachableRootExports: 170, reachablePublicApiExports: 165,
})

const summary = reconcileSourceManifest(facts, manifest)
assert.equal(summary.nodeCount, 958)
assert.equal(summary.edgeCount, 1801)
assert.equal(summary.manifestNodeCount, manifest.nodes.length)
assert.equal(summary.manifestEdgeCount, manifest.edges.length)
const mechanicalNodes = manifest.nodes.filter(item => item.classification === 'mechanical')
const reviewedNodes = manifest.nodes.filter(item => item.classification === 'reviewed')
const mechanicalEdges = manifest.edges.filter(item => item.classification === 'mechanical')
const reviewedEdges = manifest.edges.filter(item => item.classification === 'reviewed')
assert.equal(mechanicalNodes.length, 955)
assert.equal(reviewedNodes.length, 156)
assert.equal(mechanicalEdges.length, 1801)
assert.equal(reviewedEdges.length, 331)
assert(mechanicalNodes.every(item => item.ownerAuthority === undefined
  && item.security.authoritySource === undefined
  && item.security.callerIdentity === 'unclassified'
  && item.security.mutation === 'unclassified'
  && item.security.dataClasses.length === 1
  && item.security.dataClasses[0] === 'unclassified'
  && item.maturity.verification.state === 'none'
  && item.maturity.acceptance.state === 'not-candidate'))
assert(mechanicalEdges.every(item => item.crash === undefined))
assert(reviewedNodes.every(item => item.security.callerIdentity !== 'unclassified'
  && item.security.mutation !== 'unclassified'
  && item.maturity.acceptance.state !== 'accepted'))
assert(reviewedEdges.every(item => item.crash === undefined || item.classification === 'reviewed'))
{
  const promoted = structuredClone(manifest)
  const module = promoted.nodes.find(item => item.id === 'module:src/index.ts')
  module.classification = 'reviewed'
  module.ownerAuthority = { id: 'domain:agent-swarm', kind: 'domain' }
  module.security = {
    authoritySource: { id: 'domain:agent-swarm', kind: 'domain' },
    callerIdentity: 'internal-provider', mutation: 'none', dataClasses: ['workspace'], guards: [], redlines: [],
  }
  module.maturity.acceptance = { state: 'candidate' }
  promoted.nodes.push({
    ...structuredClone(module),
    id: 'transaction:reviewed-overlay-fixture',
    kind: 'transaction',
    anchors: [{ file: 'src/index.ts', symbol: 'apply', selector: 'reviewed-overlay-fixture' }],
  })
  promoted.nodes.sort((left, right) => left.id.localeCompare(right.id))
  const promotedSummary = reconcileSourceManifest(facts, promoted)
  assert.equal(promotedSummary.nodeCount, 958)
  assert.equal(promotedSummary.manifestNodeCount, manifest.nodes.length + 1)
  const drifted = structuredClone(promoted)
  drifted.nodes.find(item => item.id === 'module:src/index.ts').anchors[0].selector = 'stale-reviewed-source-anchor'
  assert.throws(() => reconcileSourceManifest(facts, drifted), error => error instanceof KnowledgeGraphError && error.code === 'KG_RECONCILE_ANCHOR')
}
for (const toolId of ['tool:agent_swarm_claim_task', 'tool:agent_swarm_continue_task', 'tool:agent_swarm_list_tasks']) {
  const tool = manifest.nodes.find(item => item.id === toolId)
  assert.equal(tool.classification, 'mechanical')
  assert.equal(tool.security.mutation, 'unclassified')
}
assert.equal(manifest.nodes.find(item => item.id === 'tool:agent_swarm_continue_task').maturity.availability.state, 'config-gated')
const registrationEdges = manifest.edges.filter(item => item.id.startsWith('edge:tool-registration/'))
assert.equal(registrationEdges.length, 20)
assert.equal(new Set(registrationEdges.map(item => item.id.slice('edge:tool-registration/'.length, 'edge:tool-registration/'.length + 2))).size, 20)
assert(registrationEdges.every(item => /^edge:tool-registration\/[0-9]{2}-/u.test(item.id)
  && !item.id.includes('undefined')
  && !item.anchors.some(anchor => anchor.selector?.includes('undefined'))))
{
  const swapped = structuredClone(facts)
  const first = swapped.toolRegistrationOrder[0].registrationOrder
  swapped.toolRegistrationOrder[0].registrationOrder = swapped.toolRegistrationOrder[1].registrationOrder
  swapped.toolRegistrationOrder[1].registrationOrder = first
  const swappedEdges = buildMechanicalInventory(swapped).edges.filter(item => item.id.startsWith('edge:tool-registration/'))
  assert.notDeepEqual(swappedEdges.map(item => [item.id, item.anchors]), registrationEdges.map(item => [item.id, item.anchors]))
}
expectCode('KG_RECONCILE_NODE_MISSING', candidate => candidate.nodes = candidate.nodes.filter(item => item.id !== 'module:src/index.ts'))
expectCode('KG_RECONCILE_NODE_EXTRA', candidate => candidate.nodes.push({ ...structuredClone(candidate.nodes.find(item => item.id === 'module:src/index.ts')), id: 'module:src/not-real.ts' }))
expectCode('KG_RECONCILE_KIND', candidate => { candidate.nodes.find(item => item.id === 'module:src/index.ts').kind = 'consumer' })
expectCode('KG_RECONCILE_ANCHOR', candidate => { candidate.nodes.find(item => item.id === 'module:src/index.ts').anchors[0].file = 'src/tools.ts' })
expectCode('KG_RECONCILE_DUPLICATE', candidate => candidate.nodes.push(structuredClone(candidate.nodes[0])))
expectCode('KG_RECONCILE_POLICY', candidate => candidate.inventoryPolicy.excludedFiles.push('src/index.ts'))
expectCode('KG_RECONCILE_EDGE_MISSING', candidate => candidate.edges = candidate.edges.filter(item => item.id !== 'edge:package-module/src/index.ts'))
expectCode('KG_RECONCILE_EDGE_EXTRA', candidate => candidate.edges.push({ ...structuredClone(candidate.edges.find(item => item.classification === 'mechanical')), id: 'edge:not-backed/by-source' }))
expectCode('KG_RECONCILE_EDGE_TYPE', candidate => { candidate.edges.find(item => item.id === 'edge:package-module/src/index.ts').type = 'exports' })
expectCode('KG_RECONCILE_ENDPOINT', candidate => { candidate.edges.find(item => item.id === 'edge:package-module/src/index.ts').to = { id: 'module:src/tools.ts', kind: 'module' } })
expectCode('KG_RECONCILE_EDGE_MISSING', candidate => { candidate.edges = candidate.edges.filter(item => item.id !== 'edge:import/src/index.ts/011') })
expectCode('KG_RECONCILE_EDGE_EXTRA', candidate => {
  const imported = structuredClone(candidate.edges.find(item => item.id === 'edge:import/src/index.ts/011'))
  imported.id = 'edge:import/src/index.ts/998'
  candidate.edges.push(imported)
})
expectFactsCode('KG_RECONCILE_ANCHOR', candidate => { candidate.config.schema.properties[0].default = 987654 })
expectFactsCode('KG_RECONCILE_ANCHOR', candidate => { candidate.rpc.schemas[0].expressionKind = 'Identifier' })
expectFactsCode('KG_RECONCILE_ANCHOR', candidate => { candidate.lifecycle.listeners[0].handler = 'semanticReplacement' })
expectFactsCode('KG_RECONCILE_ANCHOR', candidate => { candidate.reexportLayers[0].effectiveExports[0].spaces = ['type'] })
expectFactsCode('KG_RECONCILE_ANCHOR', candidate => { candidate.reachableRootExports[0].spaces = ['type', 'value'] })
expectFactsCode('KG_RECONCILE_CONTRACT', candidate => {
  candidate.modules.find(item => item.path === 'src/index.ts').imports.find(item => item.order === 11).typeOnly = true
})
expectFactsCode('KG_RECONCILE_ENDPOINT', candidate => {
  candidate.modules.find(item => item.path === 'src/index.ts').imports.find(item => item.order === 11).specifier = './tools.js'
})
expectFactsCode('KG_RECONCILE_ANCHOR', candidate => {
  candidate.modules.find(item => item.path === 'src/index.ts').imports.find(item => item.order === 11).bindings[0].local = 'renamedOnlyInFact'
})
expectFactsCode('KG_RECONCILE_NODE_MISSING', candidate => {
  const imported = candidate.modules.flatMap(item => item.imports.map(value => ({ owner: item, value }))).find(item => item.value.kind === 'external')
  imported.value.specifier = imported.value.specifier.startsWith('@') ? 'fixture-external-package' : '@fixture/external-package'
})
const assetFixtureFacts = structuredClone(facts)
assetFixtureFacts.modules.find(item => item.path === 'src/index.ts').imports.push({
  kind: 'asset', specifier: './fixture.css', order: 999, typeOnly: false, bindings: [],
})
const assetFixture = buildMechanicalInventory(assetFixtureFacts)
assert(assetFixture.nodes.some(item => item.id === 'artifact:source-resource/src/fixture.css' && item.kind === 'artifact'))
assert(assetFixture.edges.some(item => item.id === 'edge:import/src/index.ts/999' && item.type === 'imports' && item.contract === 'required' && item.to.id === 'artifact:source-resource/src/fixture.css'))
assert.deepEqual(assetFixture.inventoryPolicy.importedAssetGlobs, ['src/fixture.css'])
const dynamicFixtureFacts = structuredClone(facts)
dynamicFixtureFacts.modules.find(item => item.path === 'src/index.ts').imports.push({
  kind: 'source', specifier: './tools.js', order: 999, typeOnly: false, bindings: [], dynamic: true,
})
const dynamicEdge = buildMechanicalInventory(dynamicFixtureFacts).edges.find(item => item.id === 'edge:import/src/index.ts/999')
dynamicFixtureFacts.modules.find(item => item.path === 'src/index.ts').imports.at(-1).dynamic = false
const staticEdge = buildMechanicalInventory(dynamicFixtureFacts).edges.find(item => item.id === 'edge:import/src/index.ts/999')
assert.notDeepEqual(dynamicEdge.anchors, staticEdge.anchors)
expectSourceCollision(candidate => {
  candidate.tools.push(
    { ...structuredClone(candidate.tools[0]), name: 'QA Collision', toolName: 'QA Collision' },
    { ...structuredClone(candidate.tools[1]), name: 'qa-collision', toolName: 'qa-collision' },
  )
}, 'tool:qa-collision')
const externalCollision = (left, right, fragment) => expectSourceCollision(candidate => {
  candidate.modules[0].imports.push({ kind: 'external', specifier: left, order: 998, typeOnly: false, bindings: [] })
  candidate.modules[1].imports.push({ kind: 'external', specifier: right, order: 999, typeOnly: false, bindings: [] })
}, fragment)
externalCollision('@QA/Collision', '@qa/collision', 'package:external/qa/collision')
externalCollision('@qa/caf\u00e9', '@qa/cafe\u0301', 'package:external/qa/caf')
externalCollision('qa+collision', 'qa-collision', 'package:external/qa-collision')
console.log(`knowledge-graph reconciliation inventory fixtures: PASS (${summary.nodeCount} nodes, ${summary.edgeCount} edges)`)
