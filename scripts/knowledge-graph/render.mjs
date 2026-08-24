import { canonicalJson } from './canonical.mjs'
import { buildAgentToolRegistryOverlay } from './agent-tool-registry.mjs'

const generatedBanner = '<!-- DO NOT EDIT: generated from docs/knowledge-graph/manifest.json -->'

const viewSpecs = [
  { file: 'entrypoints-and-switches.md', title: 'Entrypoints and switches', kinds: ['package', 'entrypoint', 'config-key', 'injection'] },
  { file: 'service-provider-consumer.md', title: 'Service, Provider and Consumer', kinds: ['service', 'provider-registry', 'provider', 'consumer', 'model-tool'] },
  { file: 'domain-state.md', title: 'Domain and state', kinds: ['authority', 'official-authority', 'domain', 'entity', 'state', 'transaction', 'checkpoint', 'fence'] },
  { file: 'effect-recovery.md', title: 'Effects and recovery', kinds: ['flow', 'flow-branch', 'transaction', 'provider', 'service', 'checkpoint', 'fence', 'state-predicate'] },
  { file: 'authority-permission.md', title: 'Authority and permission', kinds: ['authority', 'official-authority', 'domain', 'guard', 'redline', 'public-capability', 'model-tool'] },
  { file: 'traceability.md', title: 'Traceability', kinds: ['public-capability', 'model-tool', 'module', 'test', 'document', 'artifact', 'gate'] },
  { file: 'availability.md', title: 'Availability', kinds: [] },
  { file: 'redlines.md', title: 'Redlines', kinds: ['redline', 'guard', 'authority', 'official-authority', 'domain'] },
]

function escapeTable(value) {
  return String(value).replaceAll('|', '\\|').replace(/[\r\n]+/gu, ' ')
}

function mermaidId(id) {
  return `n_${Buffer.from(id, 'utf8').toString('hex')}`
}

function mermaidLabel(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('[', '&#91;')
    .replaceAll(']', '&#93;')
    .replaceAll('|', '&#124;')
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/gu, char => `&#${char.codePointAt(0)};`)
}

function renderMermaid(nodes, edges) {
  if (nodes.length === 0) return '_No nodes in this view._'
  const selected = nodes.slice(0, 30)
  const ids = new Set(selected.map(node => node.id))
  const selectedEdges = edges.filter(edge => ids.has(edge.from.id) && ids.has(edge.to.id)).slice(0, 60)
  const lines = ['```mermaid', 'flowchart LR']
  for (const node of selected) lines.push(`  ${mermaidId(node.id)}["${mermaidLabel(node.title)}"]`)
  for (const edge of selectedEdges) lines.push(`  ${mermaidId(edge.from.id)} -->|${edge.type}| ${mermaidId(edge.to.id)}`)
  lines.push('```')
  if (nodes.length > selected.length || edges.length > selectedEdges.length) {
    lines.push('', `_View capped at 30 nodes and 60 edges; use atlas.json for the complete graph._`)
  }
  return lines.join('\n')
}

function renderNodeTable(nodes) {
  const lines = ['| Stable id | Kind | Classification | Implementation | Verification | Acceptance | Availability | Owner |', '|---|---|---|---|---|---|---|---|']
  for (const node of nodes) {
    const classification = node.classification === 'mechanical' ? 'MECHANICAL / UNCLASSIFIED' : 'REVIEWED'
    lines.push(`| \`${escapeTable(node.id)}\` | ${node.kind} | ${classification} | ${node.maturity.implementation.state} | ${node.maturity.verification.state} | ${node.maturity.acceptance.state} | ${node.maturity.availability.state} | \`${escapeTable(node.ownerAuthority?.id ?? '(unclassified)')}\` |`)
  }
  return lines.join('\n')
}

function nodesForView(manifest, spec) {
  if (spec.file === 'availability.md') return manifest.nodes
  return manifest.nodes.filter(node => spec.kinds.includes(node.kind))
}

function toolName(entry) {
  return entry.id.slice('tool:'.length)
}

function joinValues(values) {
  return values.length === 0 ? '—' : values.map(value => escapeTable(value)).join('<br>')
}

function renderRegistryMermaid(registry, family) {
  const entries = registry.entries.filter(entry => entry.family === family)
  const familyId = mermaidId(`family:${family}`)
  const lines = ['```mermaid', 'flowchart LR', `  ${familyId}["${mermaidLabel(family)}"]`]
  for (const entry of entries) {
    lines.push(`  ${familyId} --> ${mermaidId(entry.id)}["${mermaidLabel(toolName(entry))}"]`)
  }
  lines.push('```')
  return lines.join('\n')
}

function registryColumns(spec, entry) {
  if (spec.file === 'entrypoints-and-switches.md') {
    return [
      entry.source.module,
      entry.source.symbol,
      `${entry.availability.state}: ${entry.availability.conditions.join('; ')}`,
    ]
  }
  if (spec.file === 'service-provider-consumer.md') {
    return [entry.ownerAuthority, entry.callerPermissionClass.caller, `${entry.operation} / ${entry.domainTransactionEffect.kind}`]
  }
  if (spec.file === 'domain-state.md') return [entry.operation, entry.domainTransactionEffect.kind, entry.domainTransactionEffect.summary]
  if (spec.file === 'effect-recovery.md') return [entry.domainTransactionEffect.kind, entry.recoveryFailure, joinValues(entry.evidenceGaps)]
  if (spec.file === 'authority-permission.md') return [entry.ownerAuthority, entry.callerPermissionClass.caller, entry.callerPermissionClass.defaultPolicy]
  if (spec.file === 'traceability.md') {
    return [
      `${entry.source.module}#${entry.source.symbol}`,
      joinValues(entry.testAnchors.map(anchor => anchor.file)),
      joinValues(entry.documentationAnchors.map(anchor => anchor.file)),
    ]
  }
  if (spec.file === 'availability.md') {
    return [
      entry.availability.state,
      entry.maturity.verification.state,
      entry.maturity.acceptance.state,
      joinValues(entry.evidenceGaps),
    ]
  }
  return [entry.callerPermissionClass.caller, entry.recoveryFailure, joinValues(entry.evidenceGaps)]
}

function registryHeaders(spec) {
  if (spec.file === 'entrypoints-and-switches.md') return ['Source module', 'Symbol', 'Availability / switches']
  if (spec.file === 'service-provider-consumer.md') return ['Capability authority', 'Caller / permission', 'Operation / effect']
  if (spec.file === 'domain-state.md') return ['Operation', 'Domain relation', 'Transaction / effect summary']
  if (spec.file === 'effect-recovery.md') return ['Effect', 'Recovery / failure', 'Explicit evidence gaps']
  if (spec.file === 'authority-permission.md') return ['Capability authority (not state authority)', 'Caller class', 'Default policy']
  if (spec.file === 'traceability.md') return ['Source', 'Test anchors', 'Documentation anchors']
  if (spec.file === 'availability.md') return ['Availability', 'Verification', 'Acceptance', 'Evidence gaps']
  return ['Permission guard', 'Failure boundary', 'Unclosed evidence']
}

function renderRegistryTable(spec, entries) {
  const headers = ['Stable capability id', ...registryHeaders(spec)]
  const lines = [
    `| ${headers.join(' | ')} |`,
    `|${headers.map(() => '---').join('|')}|`,
  ]
  for (const entry of entries) {
    lines.push(`| \`${escapeTable(entry.id)}\` | ${registryColumns(spec, entry).map(escapeTable).join(' | ')} |`)
  }
  return lines.join('\n')
}

const facetViews = Object.freeze({
  'entrypoints-and-switches.md': ['tool', 'config'],
  'service-provider-consumer.md': ['tool', 'workflow', 'jobs', 'rpc'],
  'domain-state.md': ['team', 'member', 'task', 'message', 'memory', 'budget'],
  'effect-recovery.md': ['member', 'task', 'message', 'workflow', 'jobs'],
  'authority-permission.md': ['team', 'permission'],
  'traceability.md': ['tool', 'team', 'member', 'task', 'message', 'memory', 'budget', 'permission', 'workflow', 'jobs', 'rpc', 'ui', 'config'],
  'availability.md': ['config', 'workflow', 'jobs', 'rpc', 'ui'],
  'redlines.md': ['team', 'task', 'message', 'permission'],
})

function renderFunctionalFacets(spec, registry) {
  const lines = [
    '| Functional facet | Title | Source anchors | Test anchors | Related tools | Evidence gaps |',
    '|---|---|---|---|---|---|',
  ]
  for (const name of facetViews[spec.file]) {
    const facet = registry.functionalFacets[name]
    lines.push(`| \`${name}\` | ${escapeTable(facet.title)} | ${joinValues(facet.sourceAnchors.map(anchor => `${anchor.file}${anchor.symbol === undefined ? '' : `#${anchor.symbol}`}`))} | ${joinValues(facet.testAnchors.map(anchor => anchor.file))} | ${joinValues(facet.relatedToolIds)} | ${joinValues(facet.evidenceGaps)} |`)
  }
  return lines.join('\n')
}

function renderRegistryView(spec, registry, manifest, manifestDigest) {
  const overlay = buildAgentToolRegistryOverlay(registry)
  const graphNodes = nodesForView(manifest, spec)
  const graphIds = new Set(graphNodes.map(node => node.id))
  const graphEdges = manifest.edges.filter(edge => graphIds.has(edge.from.id) || graphIds.has(edge.to.id))
  const lines = [
    generatedBanner,
    '',
    `# ${spec.title}`,
    '',
    `Manifest digest: \`${manifestDigest}\``,
    '',
    `Curated tool-registry digest: \`${overlay.digest}\``,
    '',
    '> Claim ceiling: the registry is a reviewed capability overlay over exact source extraction. Per-tool deep semantic closure, acceptance, and real-Profile evidence remain explicit gaps; the complete mechanical graph is retained in `atlas.json`.',
    '',
    '## Functional facets',
    '',
    renderFunctionalFacets(spec, registry),
    '',
    '## Tool families',
  ]
  for (const family of registry.families) {
    const entries = registry.entries.filter(entry => entry.family === family)
    lines.push('', `### ${family}`, '', renderRegistryMermaid(registry, family), '', renderRegistryTable(spec, entries))
  }
  lines.push(
    '',
    '## Complete graph projection',
    '',
    renderMermaid(graphNodes, graphEdges),
    '',
    renderNodeTable(graphNodes),
    '',
  )
  return lines.join('\n')
}

export function renderAtlas(manifest, digest, toolRegistry) {
  const files = new Map()
  for (const spec of viewSpecs) {
    if (toolRegistry !== undefined) {
      files.set(spec.file, renderRegistryView(spec, toolRegistry, manifest, digest))
      continue
    }
    const nodes = nodesForView(manifest, spec)
    const ids = new Set(nodes.map(node => node.id))
    const edges = manifest.edges.filter(edge => ids.has(edge.from.id) || ids.has(edge.to.id))
    const content = [
      generatedBanner,
      '',
      `# ${spec.title}`,
      '',
      `Manifest digest: \`${digest}\``,
      '',
      renderMermaid(nodes, edges),
      '',
      renderNodeTable(nodes),
      '',
    ].join('\n')
    files.set(spec.file, content)
  }
  files.set('atlas.json', `${canonicalJson({
    schemaVersion: 1,
    manifestDigest: digest,
    graph: manifest,
    ...(toolRegistry === undefined ? {} : { toolRegistry: buildAgentToolRegistryOverlay(toolRegistry) }),
  })}\n`)
  return files
}

export const generatedFileNames = [...viewSpecs.map(spec => spec.file), 'atlas.json'].sort()
