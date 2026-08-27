import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const defaultRoot = fileURLToPath(new URL('..', import.meta.url))
const failures = []

function fail(message) {
  failures.push(message)
}

function parseRoot(argv) {
  if (argv.length === 0) {
    return defaultRoot
  }

  if (argv.length !== 2 || argv[0] !== '--repo' || !isAbsolute(argv[1])) {
    throw new Error('Usage: node scripts/verify-test-scenarios.mjs [--repo <absolute-candidate-root>]')
  }

  if (argv[1].split(/[\\/]/u).includes('..')) {
    throw new Error('Candidate root must not contain a parent traversal segment')
  }

  return argv[1]
}

function isInside(root, candidate) {
  const pathFromRoot = relative(root, candidate)
  return (
    pathFromRoot === '' ||
    (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !isAbsolute(pathFromRoot))
  )
}

async function checkedRoot(rawRoot) {
  const rootInfo = await lstat(rawRoot)
  if (rootInfo.isSymbolicLink()) {
    throw new Error(`Candidate root must not be a symbolic link: ${rawRoot}`)
  }

  const root = await realpath(rawRoot)
  if (!(await stat(root)).isDirectory()) {
    throw new Error(`Candidate root is not a directory: ${rawRoot}`)
  }

  return root
}

async function checkedFile(root, relativePath) {
  const requestedPath = resolve(root, relativePath)
  if (!isInside(root, requestedPath)) {
    throw new Error(`Refusing to read path outside candidate root: ${relativePath}`)
  }

  const info = await lstat(requestedPath)
  if (info.isSymbolicLink()) {
    throw new Error(`Refusing to follow symbolic link in candidate: ${relativePath}`)
  }

  const resolvedPath = await realpath(requestedPath)
  if (!isInside(root, resolvedPath)) {
    throw new Error(`Resolved path escapes candidate root: ${relativePath}`)
  }

  return readFile(resolvedPath, 'utf8')
}

async function checkedDirectory(root, relativePath) {
  const requestedPath = resolve(root, relativePath)
  if (!isInside(root, requestedPath)) {
    throw new Error(`Refusing to read path outside candidate root: ${relativePath}`)
  }

  const info = await lstat(requestedPath)
  if (info.isSymbolicLink()) {
    throw new Error(`Refusing to follow symbolic link in candidate: ${relativePath}`)
  }

  const resolvedPath = await realpath(requestedPath)
  if (!isInside(root, resolvedPath) || !(await stat(resolvedPath)).isDirectory()) {
    throw new Error(`Candidate directory is invalid: ${relativePath}`)
  }

  return resolvedPath
}

function extractSection(markdown) {
  const start = markdown.search(/^## 3\./mu)
  const end = markdown.search(/^## 4\./mu)

  if (start < 0 || end < 0 || end <= start) {
    fail('docs/08 lacks the expected §3 scenario section boundary')
    return ''
  }

  return markdown.slice(start, end)
}

function normalizeSummary(summary) {
  return summary
    .normalize('NFKC')
    .trim()
    .replace(/\s+/gu, ' ')
    .replace(/[.。]+$/u, '')
    .toLocaleLowerCase('en-US')
}

function parseLegacyDefinitions(section) {
  const definitions = new Map()
  for (const match of section.matchAll(/^(\d+)\.\s+(.+)$/gmu)) {
    const [_, id, summary] = match
    if (definitions.has(id)) {
      fail(`§3 repeats legacy scenario ID ${id}`)
      continue
    }
    definitions.set(id, summary.trim())
  }
  return definitions
}

function parseStableDefinitions(section) {
  const definitions = new Map()
  const summaries = new Map()
  const matcher = /^\s*(?:[-*]\s+)?\*\*(SCN-[A-Z][A-Z0-9-]*)\*\*\s*(?:—|-|:)\s*(\S.*)$/gmu

  for (const match of section.matchAll(matcher)) {
    const [_, id, summary] = match
    const normalizedSummary = normalizeSummary(summary)

    if (definitions.has(id)) {
      fail(`§3 repeats stable scenario ID ${id}`)
      continue
    }
    if (summaries.has(normalizedSummary)) {
      fail(
        `§3 repeats normalized scenario definition summary ${JSON.stringify(summary.trim())}; already used by ${summaries.get(normalizedSummary)}`,
      )
      continue
    }

    definitions.set(id, summary.trim())
    summaries.set(normalizedSummary, id)
  }

  return definitions
}

function parseAudit(document, kind) {
  const matcher =
    kind === 'stable'
      ? /Scenario audit: implemented = ([A-Z0-9,\s-]*?);\s*not yet proven = ([A-Z0-9,\s-]*?)\./u
      : /Scenario audit: implemented = ([\d,\s-]+?);\s*not yet proven = ([\d,\s-]+?)\./u
  const match = document.match(matcher)

  if (!match) {
    fail('docs/08 is missing the exact “Scenario audit: implemented = …; not yet proven = ….” line')
    return { implemented: new Set(), notProven: new Set() }
  }

  const expand = (value) => {
    const values = new Set()
    const tokens = value
      .split(',')
      .map((token) => token.trim())
      .filter(Boolean)

    for (const token of tokens) {
      if (kind === 'stable') {
        if (!/^SCN-[A-Z][A-Z0-9-]*$/u.test(token)) {
          fail(`Scenario audit contains invalid stable scenario ID ${JSON.stringify(token)}`)
          continue
        }
        values.add(token)
        continue
      }

      const range = token.match(/^(\d+)\s*-\s*(\d+)$/u)
      if (range) {
        const first = Number(range[1])
        const last = Number(range[2])
        for (let scenario = first; scenario <= last; scenario += 1) {
          values.add(String(scenario))
        }
      } else if (/^\d+$/u.test(token)) {
        values.add(token)
      } else {
        fail(`Scenario audit contains invalid scenario token ${JSON.stringify(token)}`)
      }
    }

    return values
  }

  return { implemented: expand(match[1]), notProven: expand(match[2]) }
}

async function testFiles(root) {
  const testsRoot = await checkedDirectory(root, 'tests')
  const files = []

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))

    for (const entry of entries) {
      const path = join(directory, entry.name)
      const pathFromRoot = relative(root, path)

      if (entry.isSymbolicLink()) {
        fail(`Refusing to follow symbolic link in tests: ${pathFromRoot}`)
      } else if (entry.isDirectory()) {
        await visit(path)
      } else if (entry.isFile() && /\.spec\.tsx?$/u.test(entry.name)) {
        files.push(pathFromRoot)
      }
    }
  }

  await visit(testsRoot)
  return files
}

async function evidenceIds(root, files, kind) {
  const ids = new Map()
  const matcher =
    kind === 'stable'
      ? /scenario (SCN-[A-Z][A-Z0-9-]*):|scenario-evidence:\s*(SCN-[A-Z][A-Z0-9-]*)/gu
      : /scenario (\d+):|scenario-evidence:\s*(\d+)/gu

  for (const file of files) {
    const source = await checkedFile(root, file)
    for (const match of source.matchAll(matcher)) {
      const id = match[1] ?? match[2]
      const sources = ids.get(id) ?? new Set()
      sources.add(file)
      ids.set(id, sources)
    }
  }

  return ids
}

function audit(definitions, auditSets, evidence) {
  for (const scenario of auditSets.implemented) {
    if (!definitions.has(scenario)) {
      fail(`§3 audit claims implemented scenario ${scenario}, but no §3 definition exists`)
    }
    if (!evidence.has(scenario)) {
      fail(`§3 audit claims implemented scenario ${scenario}, but no matching test evidence exists`)
    }
    if (auditSets.notProven.has(scenario)) {
      fail(`§3 scenario ${scenario} appears in both implemented and not yet proven partitions`)
    }
  }

  for (const scenario of auditSets.notProven) {
    if (!definitions.has(scenario)) {
      fail(`audit partition references undefined scenario ${scenario}`)
    }
  }

  for (const scenario of evidence.keys()) {
    if (!definitions.has(scenario)) {
      fail(`Test evidence claims scenario ${scenario}, but no §3 definition exists`)
    } else if (!auditSets.implemented.has(scenario)) {
      fail(`Test evidence proves scenario ${scenario}, but §3 does not claim it implemented`)
    }
  }

  for (const scenario of definitions.keys()) {
    if (!auditSets.implemented.has(scenario) && !auditSets.notProven.has(scenario)) {
      fail(`§3 definition ${scenario} is missing from both audit partitions`)
    }
  }
}

async function verify(argv) {
  const root = await checkedRoot(parseRoot(argv))
  const document = await checkedFile(root, 'docs/08-testing-verification.md')
  const section = extractSection(document)
  const stableDefinitions = parseStableDefinitions(section)
  const legacyDefinitions = parseLegacyDefinitions(section)

  if (stableDefinitions.size > 0 && legacyDefinitions.size > 0) {
    fail('§3 must use either legacy numeric scenarios or stable SCN-* scenarios, not both')
  }

  const kind = stableDefinitions.size > 0 ? 'stable' : 'legacy'
  const definitions = kind === 'stable' ? stableDefinitions : legacyDefinitions
  const auditSets = parseAudit(document, kind)
  const files = await testFiles(root)
  const evidence = await evidenceIds(root, files, kind)

  audit(definitions, auditSets, evidence)
  return { auditSets, definitions, evidence, files, kind }
}

try {
  const result = await verify(process.argv.slice(2))

  if (failures.length > 0) {
    console.error('Test scenario audit failed:')
    for (const failure of failures) {
      console.error(`- ${failure}`)
    }
    process.exitCode = 1
  } else {
    console.log(
      `Protocol scenario audit (${result.kind}): ${result.definitions.size} definitions, ${result.auditSets.implemented.size} implemented, ${result.auditSets.notProven.size} not yet proven, ${result.evidence.size} evidenced IDs across ${result.files.length} test files: PASS`,
    )
  }
} catch (error) {
  console.error(`Test scenario audit failed: ${error.message}`)
  process.exitCode = 1
}
