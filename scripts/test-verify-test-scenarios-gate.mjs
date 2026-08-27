import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const scriptRoot = fileURLToPath(new URL('..', import.meta.url))
const verifier = join(scriptRoot, 'scripts', 'verify-test-scenarios.mjs')
let fixtureCount = 0

function stableDocument(definitions, { implemented, notProven }) {
  return `# Fixture

## 3. Test scenarios

${definitions.map(([id, summary]) => `**${id}** — ${summary}`).join('\n')}

Scenario audit: implemented = ${implemented}; not yet proven = ${notProven}.

## 4. Evidence
`
}

function legacyDocument({ implemented = '1', notProven = '2' } = {}) {
  return `# Fixture

## 3. Test scenarios

1. Legacy default compatibility
2. Legacy unproven compatibility

Scenario audit: implemented = ${implemented}; not yet proven = ${notProven}.

## 4. Evidence
`
}

async function createFixture({ document, files = {} }) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-scenario-verifier-'))
  await mkdir(join(root, 'docs'), { recursive: true })
  await mkdir(join(root, 'tests'), { recursive: true })
  await writeFile(join(root, 'docs', '08-testing-verification.md'), document)

  for (const [relativePath, source] of Object.entries(files)) {
    const path = join(root, 'tests', relativePath)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, source)
  }

  return root
}

function run(root) {
  return spawnSync(process.execPath, [verifier, '--repo', root], { encoding: 'utf8' })
}

async function expectPass(name, fixture) {
  fixtureCount += 1
  const root = await createFixture(fixture)
  try {
    const result = run(root)
    assert.equal(result.status, 0, `${name} unexpectedly failed:\n${result.stderr}`)
    assert.match(result.stdout, /Protocol scenario audit \((?:legacy|stable)\):/u)
  } finally {
    await rm(root, { force: true, recursive: true })
  }
}

async function expectFailure(name, fixture, expected) {
  fixtureCount += 1
  const root = await createFixture(fixture)
  try {
    const result = run(root)
    assert.notEqual(result.status, 0, `${name} unexpectedly passed`)
    assert.match(result.stderr, expected, `${name} did not report its expected failure:\n${result.stderr}`)
  } finally {
    await rm(root, { force: true, recursive: true })
  }
}

await expectPass('legacy numeric compatibility', {
  document: legacyDocument(),
  files: { 'legacy.spec.ts': '// scenario 1: legacy default compatibility\n' },
})

await expectPass('stable recursive .spec.tsx evidence', {
  document: stableDocument([['SCN-RECURSIVE', 'Recursive TSX evidence']], {
    implemented: 'SCN-RECURSIVE',
    notProven: '',
  }),
  files: { 'nested/view.spec.tsx': '// scenario-evidence: SCN-RECURSIVE\n' },
})

await expectFailure(
  'duplicate stable ID',
  {
    document: stableDocument(
      [
        ['SCN-DUPLICATE', 'First definition'],
        ['SCN-DUPLICATE', 'Second definition'],
      ],
      { implemented: 'SCN-DUPLICATE', notProven: '' },
    ),
    files: { 'duplicate.spec.ts': '// scenario SCN-DUPLICATE: first definition\n' },
  },
  /repeats stable scenario ID SCN-DUPLICATE/u,
)

await expectFailure(
  'duplicate normalized summary',
  {
    document: stableDocument(
      [
        ['SCN-SUMMARY-ONE', 'Same summary.'],
        ['SCN-SUMMARY-TWO', '  same   summary  '],
      ],
      { implemented: 'SCN-SUMMARY-ONE', notProven: 'SCN-SUMMARY-TWO' },
    ),
    files: { 'summary.spec.ts': '// scenario SCN-SUMMARY-ONE: same summary\n' },
  },
  /repeats normalized scenario definition summary/u,
)

await expectFailure(
  'unknown evidence',
  {
    document: stableDocument([['SCN-KNOWN', 'Known definition']], {
      implemented: 'SCN-KNOWN',
      notProven: '',
    }),
    files: { 'unknown.spec.ts': '// scenario-evidence: SCN-UNKNOWN\n' },
  },
  /Test evidence claims scenario SCN-UNKNOWN/u,
)

await expectFailure(
  'stable unknown not-proven scenario',
  {
    document: stableDocument([['SCN-KNOWN', 'Known definition']], {
      implemented: '',
      notProven: 'SCN-GHOST',
    }),
  },
  /audit partition references undefined scenario SCN-GHOST/u,
)

await expectFailure(
  'legacy unknown not-proven scenario',
  {
    document: legacyDocument({ notProven: '999' }),
    files: { 'legacy.spec.ts': '// scenario 1: legacy default compatibility\n' },
  },
  /audit partition references undefined scenario 999/u,
)

await expectFailure(
  'duplicate legacy ID',
  {
    document: `# Fixture

## 3. Test scenarios

1. First legacy definition
1. Second legacy definition

Scenario audit: implemented = 1; not yet proven = .

## 4. Evidence
`,
    files: { 'duplicate.spec.ts': '// scenario 1: first legacy definition\n' },
  },
  /repeats legacy scenario ID 1/u,
)

await expectFailure(
  'implemented definition without evidence',
  {
    document: stableDocument([['SCN-NO-EVIDENCE', 'Missing evidence']], {
      implemented: 'SCN-NO-EVIDENCE',
      notProven: '',
    }),
  },
  /claims implemented scenario SCN-NO-EVIDENCE, but no matching test evidence/u,
)

await expectFailure(
  'overlapping audit partitions',
  {
    document: stableDocument([['SCN-OVERLAP', 'Overlapping partitions']], {
      implemented: 'SCN-OVERLAP',
      notProven: 'SCN-OVERLAP',
    }),
    files: { 'overlap.spec.ts': '// scenario SCN-OVERLAP: overlapping partitions\n' },
  },
  /appears in both implemented and not yet proven partitions/u,
)

await expectFailure(
  'definition missing audit partition',
  {
    document: stableDocument(
      [
        ['SCN-CLAIMED', 'Claimed definition'],
        ['SCN-MISSING', 'Unpartitioned definition'],
      ],
      { implemented: 'SCN-CLAIMED', notProven: '' },
    ),
    files: { 'missing.spec.ts': '// scenario-evidence: SCN-CLAIMED\n' },
  },
  /definition SCN-MISSING is missing from both audit partitions/u,
)

await expectFailure(
  'evidence-to-claim exactness',
  {
    document: stableDocument([['SCN-UNCLAIMED', 'Evidence without claim']], {
      implemented: '',
      notProven: 'SCN-UNCLAIMED',
    }),
    files: { 'unclaimed.spec.ts': '// scenario SCN-UNCLAIMED: evidence without claim\n' },
  },
  /proves scenario SCN-UNCLAIMED, but §3 does not claim it implemented/u,
)

fixtureCount += 1
const traversalRoot = await createFixture({
  document: legacyDocument(),
  files: { 'legacy.spec.ts': '// scenario 1: legacy default compatibility\n' },
})
try {
  const escapedRoot = `${traversalRoot}/../${traversalRoot.split(/[\\/]/u).at(-1)}`
  const result = run(escapedRoot)
  assert.notEqual(result.status, 0, 'candidate root with traversal unexpectedly passed')
  assert.match(result.stderr, /Candidate root must not contain a parent traversal segment/u)
} finally {
  await rm(traversalRoot, { force: true, recursive: true })
}

console.log(`verify-test-scenarios fixture gate: ${fixtureCount} fixtures (2 positive, 11 negative): PASS`)
