import { canonicalJson } from './canonical.mjs'

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

export function renderAtlas(manifest, digest) {
  const files = new Map()
  for (const spec of viewSpecs) {
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
  files.set('atlas.json', `${canonicalJson({ schemaVersion: 1, manifestDigest: digest, graph: manifest })}\n`)
  return files
}

export const generatedFileNames = [...viewSpecs.map(spec => spec.file), 'atlas.json'].sort()
