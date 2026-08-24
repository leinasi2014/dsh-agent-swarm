import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { canonicalJson, taggedSha256 } from './canonical.mjs'
import { fail } from './diagnostics.mjs'
import { parseStrictJson } from './strict-json.mjs'
import ts from 'typescript'

export const AGENT_TOOL_FACETS = Object.freeze([
  'id',
  'family',
  'source',
  'ownerAuthority',
  'callerPermissionClass',
  'operation',
  'domainTransactionEffect',
  'availability',
  'bounds',
  'recoveryFailure',
  'testAnchors',
  'documentationAnchors',
  'maturity',
])

export const AGENT_TOOL_FAMILIES = Object.freeze([
  'team-lifecycle',
  'task',
  'mailbox',
  'read',
  'budget-memory',
])

export const AGENT_TOOL_FUNCTIONAL_FACETS = Object.freeze([
  'tool',
  'team',
  'member',
  'task',
  'message',
  'memory',
  'budget',
  'permission',
  'workflow',
  'jobs',
  'rpc',
  'ui',
  'config',
])

export const AGENT_TOOL_EVIDENCE_GAPS = Object.freeze([
  'NO_DIRECT_TEST',
  'NO_COMPOSITION_TEST',
  'NO_REAL_PROFILE_EVIDENCE',
  'PROFILE_DEPENDENT',
  'CONFIG_DISABLED_BY_DEFAULT',
  'PER_TOOL_DEEP_SEMANTICS_DEFERRED',
])

const permissionClasses = new Set(['captain-only', 'team-participant'])
const operations = new Set(['read', 'mutation'])
const effectKinds = new Set([
  'authoritative-read',
  'projection-read',
  'revision-wait',
  'domain-transaction',
  'external-effect',
  'domain-transaction+external-effect',
])
const availabilityStates = new Set(['registered', 'config-disabled-by-default'])
const maturityAxes = ['implementation', 'verification', 'acceptance', 'availability']

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function exactKeys(value, expected, code, context) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(code, `${context} must be an object`)
  const actual = Object.keys(value).sort(compareText)
  const wanted = [...expected].sort(compareText)
  if (canonicalJson(actual) !== canonicalJson(wanted)) fail(code, `${context} must contain exactly ${wanted.join(', ')}`, { actual })
}

function assertString(value, code, context) {
  if (typeof value !== 'string' || value.trim() === '') fail(code, `${context} must be a non-empty string`)
}

function assertRepositoryFile(root, file, code, context, prefix) {
  assertString(file, code, context)
  if (isAbsolute(file) || file.includes('\\') || (prefix !== undefined && !file.startsWith(prefix))) fail(code, `${context} is not a permitted repository path: ${file}`)
  const target = resolve(root, file)
  const rel = relative(root, target)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !existsSync(target)) fail(code, `${context} does not resolve to a repository file: ${file}`)
  const real = realpathSync(target)
  const realRel = relative(root, real)
  if (realRel === '..' || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) fail(code, `${context} escapes the repository: ${file}`)
}

const parsedSources = new Map()

function declarationName(node) {
  if (node === undefined) return undefined
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text
  return undefined
}

function sourceDeclaresSymbol(root, anchor) {
  const path = resolve(root, anchor.file)
  let sourceFile = parsedSources.get(path)
  if (sourceFile === undefined) {
    sourceFile = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
    parsedSources.set(path, sourceFile)
  }
  const [container, member, ...rest] = anchor.symbol.split('.')
  if (rest.length > 0) return false
  if (member !== undefined) {
    const declaration = sourceFile.statements.find(statement =>
      (ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement))
      && statement.name?.text === container)
    return declaration?.members.some(item => declarationName(item.name) === member) ?? false
  }
  return sourceFile.statements.some(statement => {
    if (
      ts.isFunctionDeclaration(statement)
      || ts.isClassDeclaration(statement)
      || ts.isInterfaceDeclaration(statement)
      || ts.isTypeAliasDeclaration(statement)
      || ts.isEnumDeclaration(statement)
    ) return statement.name?.text === container
    if (!ts.isVariableStatement(statement)) return false
    return statement.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === container)
  })
}

function validateAnchor(root, anchor, code, context, prefix) {
  exactKeys(anchor, anchor.symbol === undefined ? ['file'] : ['file', 'symbol'], code, context)
  assertRepositoryFile(root, anchor.file, code, `${context}.file`, prefix)
  if (anchor.symbol !== undefined) assertString(anchor.symbol, code, `${context}.symbol`)
  if (prefix === 'src/' && anchor.symbol !== undefined && !sourceDeclaresSymbol(root, anchor)) fail('KG_TOOL_REGISTRY_SOURCE_SYMBOL', `${context} does not bind an exact top-level declaration or class/interface member: ${anchor.file}#${anchor.symbol}`)
}

function validateMaturity(maturity, entryId) {
  exactKeys(maturity, maturityAxes, 'KG_TOOL_REGISTRY_MATURITY', `${entryId}.maturity`)
  for (const axis of maturityAxes) {
    const value = maturity[axis]
    exactKeys(value, ['state', 'evidence'], 'KG_TOOL_REGISTRY_MATURITY', `${entryId}.maturity.${axis}`)
    assertString(value.state, 'KG_TOOL_REGISTRY_MATURITY', `${entryId}.maturity.${axis}.state`)
    if (!Array.isArray(value.evidence) || value.evidence.some(item => typeof item !== 'string' || item === '')) {
      fail('KG_TOOL_REGISTRY_MATURITY', `${entryId}.maturity.${axis}.evidence must be a string array`)
    }
  }
  const serialized = canonicalJson(maturity).toLowerCase()
  if (serialized.includes('accepted') || serialized.includes('real-profile') || serialized.includes('real profile')) {
    fail('KG_TOOL_REGISTRY_FALSE_MATURITY', `${entryId} cannot assert accepted or real-profile maturity`)
  }
  if (maturity.acceptance.state !== 'not-asserted' || maturity.acceptance.evidence.length !== 0) {
    fail('KG_TOOL_REGISTRY_FALSE_MATURITY', `${entryId} acceptance must remain explicitly not asserted`)
  }
}

function validateEntry(root, entry, families) {
  exactKeys(entry, [...AGENT_TOOL_FACETS, 'evidenceGaps'], 'KG_TOOL_REGISTRY_FACETS', entry?.id ?? '<entry>')
  assertString(entry.id, 'KG_TOOL_REGISTRY_ID', 'entry.id')
  if (!/^tool:agent_swarm_[a-z0-9_]+$/u.test(entry.id)) fail('KG_TOOL_REGISTRY_ID', `invalid stable tool id ${entry.id}`)
  if (!families.has(entry.family)) fail('KG_TOOL_REGISTRY_FAMILY', `${entry.id} has unknown family ${entry.family}`)

  exactKeys(entry.source, ['module', 'symbol'], 'KG_TOOL_REGISTRY_SOURCE', `${entry.id}.source`)
  assertRepositoryFile(root, entry.source.module, 'KG_TOOL_REGISTRY_SOURCE', `${entry.id}.source.module`, 'src/')
  assertString(entry.source.symbol, 'KG_TOOL_REGISTRY_SOURCE', `${entry.id}.source.symbol`)

  if (entry.ownerAuthority !== 'domain:agent-swarm') fail('KG_TOOL_REGISTRY_OWNER', `${entry.id} must name the canonical Team domain owner`)
  exactKeys(entry.callerPermissionClass, ['caller', 'defaultPolicy', 'source'], 'KG_TOOL_REGISTRY_PERMISSION', `${entry.id}.callerPermissionClass`)
  if (!permissionClasses.has(entry.callerPermissionClass.caller) || entry.callerPermissionClass.defaultPolicy !== 'allow') {
    fail('KG_TOOL_REGISTRY_PERMISSION', `${entry.id} has an incomplete caller/permission classification`)
  }
  validateAnchor(root, entry.callerPermissionClass.source, 'KG_TOOL_REGISTRY_PERMISSION', `${entry.id}.callerPermissionClass.source`, 'src/')

  if (!operations.has(entry.operation)) fail('KG_TOOL_REGISTRY_OPERATION', `${entry.id} operation must be read or mutation`)
  exactKeys(entry.domainTransactionEffect, ['kind', 'summary'], 'KG_TOOL_REGISTRY_EFFECT', `${entry.id}.domainTransactionEffect`)
  if (!effectKinds.has(entry.domainTransactionEffect.kind)) fail('KG_TOOL_REGISTRY_EFFECT', `${entry.id} has unknown effect kind`)
  assertString(entry.domainTransactionEffect.summary, 'KG_TOOL_REGISTRY_EFFECT', `${entry.id}.domainTransactionEffect.summary`)
  if (entry.operation === 'read' && !['authoritative-read', 'projection-read', 'revision-wait'].includes(entry.domainTransactionEffect.kind)) {
    fail('KG_TOOL_REGISTRY_EFFECT', `${entry.id} read operation has a mutation effect kind`)
  }
  if (entry.operation === 'mutation' && ['authoritative-read', 'projection-read', 'revision-wait'].includes(entry.domainTransactionEffect.kind)) {
    fail('KG_TOOL_REGISTRY_EFFECT', `${entry.id} mutation operation has a read effect kind`)
  }

  exactKeys(entry.availability, ['state', 'conditions'], 'KG_TOOL_REGISTRY_AVAILABILITY', `${entry.id}.availability`)
  if (!availabilityStates.has(entry.availability.state) || !Array.isArray(entry.availability.conditions) || entry.availability.conditions.some(item => typeof item !== 'string' || item === '')) {
    fail('KG_TOOL_REGISTRY_AVAILABILITY', `${entry.id} has invalid availability`)
  }
  if (!Array.isArray(entry.bounds)) fail('KG_TOOL_REGISTRY_BOUNDS', `${entry.id}.bounds must be an array`)
  for (const [index, bound] of entry.bounds.entries()) {
    exactKeys(bound, ['name', 'value', 'source'], 'KG_TOOL_REGISTRY_BOUNDS', `${entry.id}.bounds[${index}]`)
    assertString(bound.name, 'KG_TOOL_REGISTRY_BOUNDS', `${entry.id}.bounds[${index}].name`)
    if (!['string', 'number'].includes(typeof bound.value)) fail('KG_TOOL_REGISTRY_BOUNDS', `${entry.id}.bounds[${index}].value must be a string or number`)
    validateAnchor(root, bound.source, 'KG_TOOL_REGISTRY_BOUNDS', `${entry.id}.bounds[${index}].source`, 'src/')
  }
  assertString(entry.recoveryFailure, 'KG_TOOL_REGISTRY_RECOVERY', `${entry.id}.recoveryFailure`)

  if (!Array.isArray(entry.testAnchors)) fail('KG_TOOL_REGISTRY_TEST_ANCHOR', `${entry.id}.testAnchors must be an array`)
  for (const [index, anchor] of entry.testAnchors.entries()) validateAnchor(root, anchor, 'KG_TOOL_REGISTRY_TEST_ANCHOR', `${entry.id}.testAnchors[${index}]`, 'tests/')
  if (!Array.isArray(entry.documentationAnchors) || entry.documentationAnchors.length === 0) fail('KG_TOOL_REGISTRY_DOCUMENT_ANCHOR', `${entry.id} requires documentation anchors`)
  for (const [index, anchor] of entry.documentationAnchors.entries()) validateAnchor(root, anchor, 'KG_TOOL_REGISTRY_DOCUMENT_ANCHOR', `${entry.id}.documentationAnchors[${index}]`, 'docs/')
  validateMaturity(entry.maturity, entry.id)

  if (!Array.isArray(entry.evidenceGaps) || new Set(entry.evidenceGaps).size !== entry.evidenceGaps.length) fail('KG_TOOL_REGISTRY_EVIDENCE_GAP', `${entry.id}.evidenceGaps must be a unique array`)
  for (const gap of entry.evidenceGaps) if (!AGENT_TOOL_EVIDENCE_GAPS.includes(gap)) fail('KG_TOOL_REGISTRY_EVIDENCE_GAP', `${entry.id} has unknown evidence gap ${gap}`)
  for (const required of ['NO_REAL_PROFILE_EVIDENCE', 'PROFILE_DEPENDENT', 'PER_TOOL_DEEP_SEMANTICS_DEFERRED']) {
    if (!entry.evidenceGaps.includes(required)) fail('KG_TOOL_REGISTRY_EVIDENCE_GAP', `${entry.id} must keep ${required} explicit`)
  }
  if (entry.testAnchors.length === 0) {
    for (const required of ['NO_DIRECT_TEST', 'NO_COMPOSITION_TEST']) {
      if (!entry.evidenceGaps.includes(required)) fail('KG_TOOL_REGISTRY_EVIDENCE_GAP', `${entry.id} without tests must declare ${required}`)
    }
  }
  const configDisabled = entry.availability.state === 'config-disabled-by-default'
  if (configDisabled !== entry.evidenceGaps.includes('CONFIG_DISABLED_BY_DEFAULT')) fail('KG_TOOL_REGISTRY_AVAILABILITY', `${entry.id} config-disabled state and evidence gap disagree`)
}

export function validateAgentToolRegistry(root, registry) {
  exactKeys(registry, ['schemaVersion', 'facetCount', 'families', 'functionalFacets', 'entries'], 'KG_TOOL_REGISTRY_SCHEMA', 'registry')
  if (registry.schemaVersion !== 1 || registry.facetCount !== AGENT_TOOL_FUNCTIONAL_FACETS.length) fail('KG_TOOL_REGISTRY_SCHEMA', 'registry schema/facet count is not supported')
  if (!Array.isArray(registry.families) || canonicalJson(registry.families) !== canonicalJson(AGENT_TOOL_FAMILIES)) fail('KG_TOOL_REGISTRY_FAMILY', 'registry families must use the canonical order')
  if (!Array.isArray(registry.entries)) fail('KG_TOOL_REGISTRY_SCHEMA', 'registry.entries must be an array')
  const ids = registry.entries.map(entry => entry.id)
  if (new Set(ids).size !== ids.length) fail('KG_TOOL_REGISTRY_DUPLICATE_ID', 'registry tool ids must be unique')
  const sorted = [...ids].sort(compareText)
  if (canonicalJson(ids) !== canonicalJson(sorted)) fail('KG_TOOL_REGISTRY_ORDER', 'registry entries must be sorted by stable id')
  const families = new Set(registry.families)
  for (const entry of registry.entries) validateEntry(root, entry, families)
  const facetNames = Object.keys(registry.functionalFacets)
  if (canonicalJson(facetNames) !== canonicalJson(AGENT_TOOL_FUNCTIONAL_FACETS)) {
    fail('KG_TOOL_REGISTRY_FUNCTIONAL_FACETS', 'functional facets must be the canonical ordered 13-facet set', { actual: facetNames })
  }
  const entryIds = new Set(ids)
  for (const facetName of AGENT_TOOL_FUNCTIONAL_FACETS) {
    const facet = registry.functionalFacets[facetName]
    exactKeys(facet, ['title', 'sourceAnchors', 'testAnchors', 'relatedToolIds', 'evidenceGaps'], 'KG_TOOL_REGISTRY_FUNCTIONAL_FACET_FIELDS', `functionalFacets.${facetName}`)
    assertString(facet.title, 'KG_TOOL_REGISTRY_FUNCTIONAL_FACET_FIELDS', `functionalFacets.${facetName}.title`)
    if (!Array.isArray(facet.sourceAnchors) || facet.sourceAnchors.length === 0) fail('KG_TOOL_REGISTRY_FUNCTIONAL_FACET_ANCHOR', `${facetName} requires a source anchor`)
    for (const [index, anchor] of facet.sourceAnchors.entries()) validateAnchor(root, anchor, 'KG_TOOL_REGISTRY_FUNCTIONAL_FACET_ANCHOR', `functionalFacets.${facetName}.sourceAnchors[${index}]`, 'src/')
    if (!Array.isArray(facet.testAnchors)) fail('KG_TOOL_REGISTRY_FUNCTIONAL_FACET_ANCHOR', `${facetName}.testAnchors must be an array`)
    for (const [index, anchor] of facet.testAnchors.entries()) validateAnchor(root, anchor, 'KG_TOOL_REGISTRY_FUNCTIONAL_FACET_ANCHOR', `functionalFacets.${facetName}.testAnchors[${index}]`, 'tests/')
    if (!Array.isArray(facet.relatedToolIds) || facet.relatedToolIds.length === 0 || new Set(facet.relatedToolIds).size !== facet.relatedToolIds.length) fail('KG_TOOL_REGISTRY_FUNCTIONAL_FACET_REF', `${facetName}.relatedToolIds must be a non-empty unique array`)
    for (const id of facet.relatedToolIds) if (!entryIds.has(id)) fail('KG_TOOL_REGISTRY_FUNCTIONAL_FACET_REF', `${facetName} references unknown tool ${id}`)
    if (!Array.isArray(facet.evidenceGaps) || new Set(facet.evidenceGaps).size !== facet.evidenceGaps.length) fail('KG_TOOL_REGISTRY_FUNCTIONAL_FACET_GAP', `${facetName}.evidenceGaps must be a unique array`)
    for (const gap of facet.evidenceGaps) if (!AGENT_TOOL_EVIDENCE_GAPS.includes(gap)) fail('KG_TOOL_REGISTRY_FUNCTIONAL_FACET_GAP', `${facetName} has unknown evidence gap ${gap}`)
  }
  for (const family of registry.families) if (!registry.entries.some(entry => entry.family === family)) fail('KG_TOOL_REGISTRY_FAMILY', `family ${family} is empty`)
  for (const permissionClass of permissionClasses) if (!registry.entries.some(entry => entry.callerPermissionClass.caller === permissionClass)) fail('KG_TOOL_REGISTRY_PERMISSION', `permission class ${permissionClass} is uncovered`)
  return registry
}

export function validateAgentToolRegistryAgainstFacts(registry, facts) {
  const extracted = new Map(facts.tools.map(tool => [`tool:${tool.name}`, tool]))
  const curated = new Map(registry.entries.map(entry => [entry.id, entry]))
  const missing = [...extracted.keys()].filter(id => !curated.has(id)).sort(compareText)
  const extra = [...curated.keys()].filter(id => !extracted.has(id)).sort(compareText)
  if (missing.length > 0 || extra.length > 0) fail('KG_TOOL_REGISTRY_SET_MISMATCH', 'curated registry and extracted model-tool sets differ', { missing, extra })
  for (const [id, tool] of extracted) {
    const entry = curated.get(id)
    if (entry.source.module !== tool.file || entry.source.symbol !== tool.registrationFunction) {
      fail('KG_TOOL_REGISTRY_SOURCE_MISMATCH', `${id} source module/symbol differs from the extractor`, { curated: entry.source, extracted: { module: tool.file, symbol: tool.registrationFunction } })
    }
  }
  if (registry.entries.length !== 19 || facts.tools.length !== 19) fail('KG_TOOL_REGISTRY_TOOL_COUNT', `expected the closed 19-tool surface; registry=${registry.entries.length}, extractor=${facts.tools.length}`)
  return { toolCount: registry.entries.length, facetCount: AGENT_TOOL_FUNCTIONAL_FACETS.length }
}

function relationshipId(type, from, to) {
  return `tool-overlay:${type}/${from.replaceAll(':', '/')}/${to.replaceAll(':', '/')}`
}

export function buildAgentToolRegistryOverlay(registry) {
  const edges = []
  for (const entry of registry.entries) {
    const permissionGuard = entry.callerPermissionClass.caller === 'captain-only' ? 'guard:captain-only-tool-filter' : 'guard:live-team-participant'
    for (const [type, from, to, status] of [
      ['owns', entry.ownerAuthority, entry.id, 'curated'],
      ['guards', permissionGuard, entry.id, 'curated'],
    ]) edges.push({ id: relationshipId(type, from, to), type, from, to, evidenceStatus: status })
    for (const anchor of entry.testAnchors) {
      const target = `test-file:${anchor.file}`
      edges.push({ id: relationshipId('test-anchored-by', entry.id, target), type: 'test-anchored-by', from: entry.id, to: target, evidenceStatus: 'anchored', anchor })
    }
    for (const anchor of entry.documentationAnchors) {
      const target = `document-file:${anchor.file}`
      edges.push({ id: relationshipId('documented-by', entry.id, target), type: 'documented-by', from: entry.id, to: target, evidenceStatus: 'anchored', anchor })
    }
  }
  edges.sort((left, right) => compareText(left.id, right.id))
  if (new Set(edges.map(edge => edge.id)).size !== edges.length) fail('KG_TOOL_REGISTRY_EDGE_COLLISION', 'derived overlay edges must have unique ids')
  return {
    schemaVersion: 1,
    classification: 'reviewed-curated-capability-overlay',
    claimCeiling: 'Per-tool deep semantic closure and real-Profile acceptance are not asserted.',
    digest: taggedSha256('dsh-agent-swarm/kg-agent-tool-registry/v1', registry),
    entryFields: AGENT_TOOL_FACETS,
    functionalFacets: registry.functionalFacets,
    evidenceGapVocabulary: AGENT_TOOL_EVIDENCE_GAPS,
    families: registry.families,
    entries: registry.entries,
    edges,
  }
}

export async function loadAgentToolRegistry(root, path = 'docs/knowledge-graph/agent-tools.json') {
  const raw = await readFile(resolve(root, path), 'utf8')
  return validateAgentToolRegistry(root, parseStrictJson(raw, path))
}
