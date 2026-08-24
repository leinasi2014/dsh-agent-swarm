#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const OUTPUT_SCHEMA_VERSION = 1 // Stable CLI envelope; independent of atlas schema versions.
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100
const DEFAULT_DEPTH = 4
const MAX_DEPTH = 8
const MAX_VISITED = 10_000
const COMMANDS = new Set(['check', 'search', 'show', 'edges', 'path', 'anchors'])
const LIVE_COMMANDS = new Set(['status', 'live', 'runtime', 'health'])

class QueryError extends Error {
  constructor(code, message, details) {
    super(message)
    this.code = code
    this.details = details
  }
}

function fail(code, message, details) {
  throw new QueryError(code, message, details)
}

function parseBound(value, fallback, maximum, name) {
  if (value === undefined) return fallback
  if (!/^[1-9]\d*$/u.test(String(value))) fail('KG_QUERY_ARGUMENT', `${name} must be a positive integer`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    fail('KG_QUERY_LIMIT', `${name} exceeds the maximum`, { maximum, requested: String(value) })
  }
  return parsed
}

function takeOption(tokens, name) {
  const index = tokens.indexOf(name)
  if (index < 0) return undefined
  if (index === tokens.length - 1) fail('KG_QUERY_ARGUMENT', `${name} requires a value`)
  const value = tokens[index + 1]
  tokens.splice(index, 2)
  return value
}

function parseArgs(argv, env) {
  const tokens = [...argv]
  const command = tokens.shift()
  if (!command) fail('KG_QUERY_USAGE', 'a command is required', { commands: [...COMMANDS] })
  if (LIVE_COMMANDS.has(command)) {
    fail('KG_QUERY_RUNTIME_AUTHORITY', 'live state is not present in the static knowledge graph')
  }
  if (!COMMANDS.has(command)) fail('KG_QUERY_USAGE', `unknown command: ${command}`, { commands: [...COMMANDS] })
  const limit = parseBound(takeOption(tokens, '--limit') ?? env.KG_QUERY_LIMIT, DEFAULT_LIMIT, MAX_LIMIT, 'limit')
  const depth = parseBound(takeOption(tokens, '--depth') ?? env.KG_QUERY_DEPTH, DEFAULT_DEPTH, MAX_DEPTH, 'depth')
  const direction = takeOption(tokens, '--direction') ?? 'both'
  const type = takeOption(tokens, '--type')
  if (!['in', 'out', 'both'].includes(direction)) fail('KG_QUERY_ARGUMENT', 'direction must be in, out, or both')
  const liveText = tokens.join(' ')
  if (/(?:\b(?:current|live|realtime|real-time|runtime|active)\b.*\b(?:status|state|health|tasks?|jobs?|leases?|ports?|profiles?|members?)\b)|(?:实时|当前|运行中).*(?:状态|任务|成员|作业|租约|端口|健康)/iu.test(liveText)) {
    fail('KG_QUERY_RUNTIME_AUTHORITY', 'live state is not present in the static knowledge graph')
  }
  return { command, tokens, limit, depth, direction, type }
}

function validateAtlas(value) {
  if (!value || typeof value !== 'object' || value.schemaVersion !== 1 || typeof value.manifestDigest !== 'string') {
    fail('KG_QUERY_ATLAS_SCHEMA', 'atlas envelope is invalid')
  }
  if (!value.graph || !Array.isArray(value.graph.nodes) || !Array.isArray(value.graph.edges)) {
    fail('KG_QUERY_ATLAS_SCHEMA', 'atlas graph must contain node and edge arrays')
  }
  const ids = new Set()
  for (const node of value.graph.nodes) {
    if (!node || typeof node.id !== 'string' || typeof node.kind !== 'string' || typeof node.title !== 'string' || ids.has(node.id)) {
      fail('KG_QUERY_ATLAS_SCHEMA', 'atlas contains an invalid or duplicate node')
    }
    ids.add(node.id)
  }
  for (const edge of value.graph.edges) {
    if (!edge || typeof edge.id !== 'string' || typeof edge.type !== 'string' || !ids.has(edge.from?.id) || !ids.has(edge.to?.id)) {
      fail('KG_QUERY_ATLAS_SCHEMA', 'atlas contains an invalid edge')
    }
  }
  return value
}

function compactNode(node) {
  return { id: node.id, kind: node.kind, title: node.title, classification: node.classification }
}

function compareIds(left, right) {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

function nodeInterpretation(node) {
  return node.classification === 'mechanical'
    ? { scope: 'source-location-only', runtimeAuthority: false, warning: 'Mechanical extraction does not establish runtime semantics.' }
    : { scope: 'static-contract', runtimeAuthority: false }
}

function searchable(node) {
  return [node.id, node.title, node.kind, ...(Array.isArray(node.tags) ? node.tags : [])].join('\n').toLocaleLowerCase('en-US')
}

function matchingNodes(graph, text) {
  const needle = text.toLocaleLowerCase('en-US')
  return graph.nodes.filter(node => searchable(node).includes(needle)).sort(compareIds)
}

function requireText(tokens, command, count = 1) {
  if (tokens.length !== count || tokens.some(token => token.length === 0)) {
    fail('KG_QUERY_USAGE', `${command} requires ${count === 1 ? 'one argument' : `${count} arguments`}`)
  }
}

function resolveNode(graph, text, limit) {
  const exact = graph.nodes.find(node => node.id === text)
  if (exact) return exact
  const matches = matchingNodes(graph, text)
  if (matches.length === 0) fail('KG_QUERY_NOT_FOUND', `no node matches: ${text}`)
  if (matches.length > 1) {
    fail('KG_QUERY_AMBIGUOUS', `multiple nodes match: ${text}`, {
      candidates: matches.slice(0, limit).map(compactNode),
      truncated: matches.length > limit,
    })
  }
  return matches[0]
}

function edgeView(edge, nodes) {
  return {
    id: edge.id,
    type: edge.type,
    classification: edge.classification,
    from: compactNode(nodes.get(edge.from.id)),
    to: compactNode(nodes.get(edge.to.id)),
    anchors: edge.anchors ?? [],
  }
}

function queryAtlas(atlas, parsed) {
  const graph = atlas.graph
  const nodes = new Map(graph.nodes.map(node => [node.id, node]))
  if (parsed.command === 'check') {
    requireText(parsed.tokens, 'check', 0)
    return {
      manifestDigest: atlas.manifestDigest,
      graphSchemaVersion: graph.schemaVersion,
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      runtimeAuthority: false,
    }
  }
  if (parsed.command === 'search') {
    requireText(parsed.tokens, 'search')
    const matches = matchingNodes(graph, parsed.tokens[0])
    return { query: parsed.tokens[0], matches: matches.slice(0, parsed.limit).map(compactNode), truncated: matches.length > parsed.limit }
  }
  if (parsed.command === 'show') {
    requireText(parsed.tokens, 'show')
    const node = resolveNode(graph, parsed.tokens[0], parsed.limit)
    return { node, interpretation: nodeInterpretation(node) }
  }
  if (parsed.command === 'edges') {
    requireText(parsed.tokens, 'edges')
    const node = resolveNode(graph, parsed.tokens[0], parsed.limit)
    const matches = graph.edges
      .filter(edge => (parsed.direction === 'both' || parsed.direction === 'out') && edge.from.id === node.id
        || (parsed.direction === 'both' || parsed.direction === 'in') && edge.to.id === node.id)
      .filter(edge => parsed.type === undefined || edge.type === parsed.type)
      .sort(compareIds)
    return { node: compactNode(node), direction: parsed.direction, type: parsed.type ?? null, edges: matches.slice(0, parsed.limit).map(edge => edgeView(edge, nodes)), truncated: matches.length > parsed.limit }
  }
  if (parsed.command === 'anchors') {
    requireText(parsed.tokens, 'anchors')
    const node = resolveNode(graph, parsed.tokens[0], parsed.limit)
    const incident = graph.edges.filter(edge => edge.from.id === node.id || edge.to.id === node.id).sort(compareIds)
    return {
      node: compactNode(node),
      anchors: node.anchors ?? [],
      incidentEdges: incident.slice(0, parsed.limit).map(edge => ({ id: edge.id, anchors: edge.anchors ?? [] })),
      truncated: incident.length > parsed.limit,
      interpretation: nodeInterpretation(node),
    }
  }
  requireText(parsed.tokens, 'path', 2)
  const from = resolveNode(graph, parsed.tokens[0], parsed.limit)
  const to = resolveNode(graph, parsed.tokens[1], parsed.limit)
  if (from.id === to.id) return { from: compactNode(from), to: compactNode(to), depth: 0, nodes: [compactNode(from)], edges: [] }
  const adjacency = new Map()
  for (const edge of [...graph.edges].sort(compareIds)) {
    const entries = adjacency.get(edge.from.id) ?? []
    entries.push({ edge, next: edge.to.id })
    adjacency.set(edge.from.id, entries)
  }
  const queue = [{ id: from.id, nodeIds: [from.id], edges: [] }]
  const visited = new Set([from.id])
  while (queue.length > 0) {
    const current = queue.shift()
    if (current.edges.length >= parsed.depth) continue
    for (const step of adjacency.get(current.id) ?? []) {
      if (visited.size >= MAX_VISITED) fail('KG_QUERY_PATH_LIMIT', 'path search exceeded its visited-node bound', { maximum: MAX_VISITED })
      if (visited.has(step.next)) continue
      const candidate = { id: step.next, nodeIds: [...current.nodeIds, step.next], edges: [...current.edges, step.edge] }
      if (step.next === to.id) {
        return {
          from: compactNode(from), to: compactNode(to), depth: candidate.edges.length,
          nodes: candidate.nodeIds.map(id => compactNode(nodes.get(id))),
          edges: candidate.edges.map(edge => edgeView(edge, nodes)),
        }
      }
      visited.add(step.next)
      queue.push(candidate)
    }
  }
  fail('KG_QUERY_PATH_NOT_FOUND', `no directed path found within depth ${parsed.depth}`, { from: from.id, to: to.id, depth: parsed.depth })
}

function defaultVerify(projectRoot, env) {
  const script = join(projectRoot, 'scripts', 'verify-knowledge-graph.mjs')
  return spawnSync(process.execPath, [script, '--root', projectRoot], {
    cwd: projectRoot,
    encoding: 'utf8',
    env,
    timeout: 60_000,
    windowsHide: true,
  })
}

function verifierFailure(result) {
  const output = `${result.stderr ?? ''}\n${result.stdout ?? ''}`
  const match = output.match(/\b(KG_GENERATED_[A-Z0-9_]+):\s*([^\r\n]*)/u)
  if (match) return new QueryError(match[1], match[2] || 'generated knowledge graph verification failed')
  const cause = output.match(/\b(KG_[A-Z0-9_]+):/u)?.[1]
  return new QueryError('KG_QUERY_VERIFICATION_FAILED', 'knowledge graph verification failed', cause ? { cause } : undefined)
}

export async function runQuery(argv, options = {}) {
  let command = argv[0] ?? null
  try {
    const env = options.env ?? process.env
    const projectRoot = resolve(options.projectRoot ?? fileURLToPath(new URL('../../../../', import.meta.url)))
    const parsed = parseArgs(argv, env)
    command = parsed.command
    const verify = options.verify ?? defaultVerify
    const verification = await verify(projectRoot, env)
    if (verification.error) throw new QueryError('KG_QUERY_VERIFICATION_FAILED', verification.error.message)
    if (verification.status !== 0) throw verifierFailure(verification)
    const atlasPath = join(projectRoot, 'docs', 'generated', 'knowledge-graph', 'atlas.json')
    let text
    try {
      text = await (options.readFile ?? readFile)(atlasPath, 'utf8')
    } catch (error) {
      throw new QueryError('KG_QUERY_ATLAS_MISSING', 'verified atlas could not be read', { cause: error?.code ?? 'READ_FAILED' })
    }
    let atlas
    try {
      atlas = JSON.parse(text)
    } catch {
      throw new QueryError('KG_QUERY_ATLAS_SCHEMA', 'atlas is not valid JSON')
    }
    const data = queryAtlas(validateAtlas(atlas), parsed)
    return { exitCode: 0, value: { schemaVersion: OUTPUT_SCHEMA_VERSION, ok: true, command, data } }
  } catch (error) {
    const known = error instanceof QueryError ? error : new QueryError('KG_QUERY_INTERNAL', error instanceof Error ? error.message : String(error))
    return {
      exitCode: 1,
      value: {
        schemaVersion: OUTPUT_SCHEMA_VERSION,
        ok: false,
        command,
        error: { code: known.code, message: known.message, ...(known.details === undefined ? {} : { details: known.details }) },
      },
    }
  }
}

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isEntrypoint) {
  const result = await runQuery(process.argv.slice(2))
  process.stdout.write(`${JSON.stringify(result.value)}\n`)
  process.exitCode = result.exitCode
}
