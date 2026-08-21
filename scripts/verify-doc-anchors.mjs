import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const docsRoot = join(root, 'docs')
const repositories = ['dsh-agent-teams', 'jiuwenswarm']
const sourceRoots = new Map(repositories.map(repository => [
  repository,
  join(root, 'ref', repository, 'source'),
]))
const repositorySignals = new Map([
  ['dsh-agent-teams', /\bdsh-agent-teams\b/iu],
  ['jiuwenswarm', /\b(?:jiuwenswarm|jiuwen swarm|openjiuwen)\b/iu],
])
const distinctivePrefixes = new Map([
  ['jiuwenswarm', ['jiuwenswarm/', 'jiuwenbox/']],
])
const anchorPattern = /(?<![\w@.+/\\-])(?<path>[\w@.+-]+(?:[/\\][\w@.+-]+)*)\.(?<extension>ts|tsx|mts|cts|js|jsx|mjs|cjs|py|pyi|rs|go|java|kt|kts|cs|cpp|cc|cxx|c|h|hpp|rb|php|swift|scala|sh|ps1|yaml|yml|json|toml):(?<line>[1-9]\d*)(?:-\d+)?(?<continuations>(?:\s*,\s*[1-9]\d*(?:-\d+)?)*)/giu
const ignoredWords = new Set([
  'after', 'against', 'before', 'boolean', 'class', 'const', 'context', 'current',
  'default', 'docs', 'each', 'export', 'false', 'file', 'from', 'function',
  'import', 'interface', 'into', 'line', 'lines', 'number', 'official', 'only',
  'plugin', 'return', 'source', 'string', 'target', 'that', 'their', 'then', 'this',
  'true', 'type', 'undefined', 'when', 'where', 'which', 'while', 'with',
])

const args = process.argv.slice(2)
const emit = args.length === 1 && args[0] === '--emit'
if (args.length > 0 && !emit) {
  console.error('Usage: node scripts/verify-doc-anchors.mjs [--emit]')
  process.exitCode = 1
} else {
  const anchors = await collectAnchors()
  if (emit) {
    console.log(JSON.stringify(anchors.map(anchor => ({
      repository: anchor.repository,
      path: anchor.path,
      line: anchor.line,
      source: sourceLabel(anchor),
      document: anchor.document,
      documentLine: anchor.documentLine,
    })), null, 2))
  } else {
    await verifyAnchors(anchors)
  }
}

async function collectAnchors() {
  const documents = await markdownFiles(docsRoot)
  const anchors = []

  for (const documentPath of documents) {
    const content = await readFile(documentPath, 'utf8')
    const lines = content.split('\n')
    const headings = []
    let offset = 0

    for (let index = 0; index < lines.length; index += 1) {
      const text = lines[index]
      const heading = /^(#{1,6})\s+(.+)$/u.exec(text)
      if (heading !== null) {
        const level = heading[1].length
        while (headings.at(-1)?.level >= level) headings.pop()
        headings.push({ level, text: heading[2] })
      }

      anchorPattern.lastIndex = 0
      for (const match of text.matchAll(anchorPattern)) {
        const rawPath = `${match.groups.path}.${match.groups.extension}`.replaceAll('\\', '/')
        const contextStart = Math.max(0, offset + match.index - 200)
        const contextEnd = Math.min(content.length, offset + match.index + match[0].length + 200)
        const context = content.slice(contextStart, contextEnd)
        const resolved = classifyPath(rawPath, `${headings.map(item => item.text).join(' ')} ${context}`)
        if (resolved === undefined) continue

        const lineNumbers = [
          Number(match.groups.line),
          ...[...match.groups.continuations.matchAll(/,\s*(?<line>[1-9]\d*)/gu)]
            .map(item => Number(item.groups.line)),
        ]
        for (const line of lineNumbers) {
          anchors.push({
            repository: resolved.repository,
            path: resolved.path,
            line,
            document: slash(relative(root, documentPath)),
            documentLine: index + 1,
            context: context.replace(match[0], ' '),
          })
        }
      }

      offset += text.length + 1
    }
  }

  return anchors.sort((left, right) => left.document.localeCompare(right.document)
    || left.documentLine - right.documentLine
    || left.path.localeCompare(right.path)
    || left.line - right.line)
}

function classifyPath(rawPath, context) {
  for (const repository of repositories) {
    for (const prefix of [`ref/${repository}/source/`, `${repository}/source/`, `${repository}/`]) {
      if (rawPath.startsWith(prefix)) return safePath(repository, rawPath.slice(prefix.length))
    }
  }

  const signalled = repositories.filter(repository => repositorySignals.get(repository).test(context))
  if (signalled.length === 1) return safePath(signalled[0], rawPath)

  for (const [repository, prefixes] of distinctivePrefixes) {
    if (prefixes.some(prefix => rawPath.startsWith(prefix))) return safePath(repository, rawPath)
  }

  return undefined
}

function safePath(repository, candidate) {
  const segments = candidate.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) return undefined
  return { repository, path: segments.join('/') }
}

async function markdownFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'archive' || entry.name === 'reviews') continue
      files.push(...await markdownFiles(path))
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(path)
    }
  }
  return files.sort()
}

async function verifyAnchors(anchors) {
  const failures = []
  const cache = new Map()

  for (const anchor of anchors) {
    const key = `${anchor.repository}\0${anchor.path}`
    let lines = cache.get(key)
    if (lines === undefined) {
      try {
        lines = sourceLines(await readFile(join(sourceRoots.get(anchor.repository), ...anchor.path.split('/')), 'utf8'))
        cache.set(key, lines)
      } catch {
        failures.push({ anchor, reason: 'source file is missing' })
        continue
      }
    }

    if (anchor.line > lines.length) {
      failures.push({ anchor, reason: `line ${anchor.line} exceeds ${lines.length}` })
      continue
    }

    const targetIdentifiers = identifiers(lines[anchor.line - 1])
    const contextIdentifiers = identifiers(anchor.context)
    if (targetIdentifiers.size > 0
      && contextIdentifiers.size > 0
      && !targetIdentifiers.intersection(contextIdentifiers).size) {
      failures.push({ anchor, reason: 'target line has no contextual identifier overlap' })
    }
  }

  if (failures.length > 0) {
    console.error('Documentation anchor verification failed:')
    for (const { anchor, reason } of failures) {
      console.error(`- ${sourceLabel(anchor)} → ${anchor.document}:${anchor.documentLine} (${reason})`)
    }
    process.exitCode = 1
  } else {
    console.log(`Documentation anchors (${anchors.length}): PASS`)
  }
}

function identifiers(text) {
  const result = new Set()
  for (const match of text.matchAll(/[A-Za-z_$][A-Za-z0-9_$-]*|\d{2,}/gu)) {
    if (/^\d+$/u.test(match[0])) {
      result.add(match[0])
      continue
    }
    const expanded = match[0].replaceAll(/([a-z0-9])([A-Z])/g, '$1 $2')
    for (const part of [match[0], ...expanded.split(/[_$\s-]+/u)]) {
      const normalized = part.toLowerCase()
      if (normalized.length >= 4 && !ignoredWords.has(normalized)) result.add(normalized)
    }
  }
  return result
}

function sourceLines(content) {
  if (content === '') return []
  const lines = content.split(/\r\n|\n|\r/u)
  if (lines.at(-1) === '') lines.pop()
  return lines
}

function sourceLabel(anchor) {
  return `ref/${anchor.repository}/source/${anchor.path}:${anchor.line}`
}

function slash(path) {
  return path.replaceAll('\\', '/')
}
