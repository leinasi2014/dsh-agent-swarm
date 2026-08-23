import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const sourceRoot = fileURLToPath(new URL('..', import.meta.url))
const verifier = join(sourceRoot, 'scripts', 'verify-governance.mjs')
const sandbox = mkdtempSync(join(tmpdir(), 'swarm-governance-gate-'))

function copyFixture(name) {
  const root = join(sandbox, name)
  mkdirSync(root, { recursive: true })
  for (const item of ['AGENTS.md', 'CLAUDE.md', 'CONTRIBUTING.md', 'README.md', 'LICENSE', 'docs']) {
    cpSync(join(sourceRoot, item), join(root, item), { recursive: true })
  }
  return root
}

function run(root) {
  return spawnSync(process.execPath, [verifier, '--root', root, '--skip-git'], {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  })
}

function mutate(root, path, change) {
  const target = join(root, path)
  mkdirSync(dirname(target), { recursive: true })
  const before = readFileSync(target, 'utf8')
  writeFileSync(target, change(before), 'utf8')
}

function expectFailure(name, mutation, expected) {
  const root = copyFixture(name)
  mutation(root)
  const result = run(root)
  const output = `${result.stdout}\n${result.stderr}`
  if (result.status === 0 || !output.includes(expected)) {
    throw new Error(`${name}: expected failure containing ${JSON.stringify(expected)}, got status ${result.status}\n${output}`)
  }
}

try {
  const positive = run(copyFixture('positive'))
  if (positive.status !== 0) throw new Error(`positive fixture failed\n${positive.stdout}\n${positive.stderr}`)

  expectFailure('missing-binding', root => {
    rmSync(join(root, 'docs', 'governance', 'project-binding.yaml'))
  }, 'project-binding.yaml: missing')

  expectFailure('missing-registry', root => {
    rmSync(join(root, 'docs', 'governance', 'document-registry.yaml'))
  }, 'document-registry.yaml: missing')

  expectFailure('thick-adapter', root => {
    mutate(root, 'AGENTS.md', content => `${content}${'extra\n'.repeat(90)}`)
  }, 'exceeds thin-adapter limit')

  expectFailure('broken-link', root => {
    mutate(root, 'docs/README.md', content => `${content}\n[broken](missing-authority.md)\n`)
  }, 'broken local link')

  expectFailure('dynamic-state', root => {
    mutate(root, 'docs/11-official-first-development.md', content => `${content}\n## 当前状态\n\n进行中\n`)
  }, 'stable-document firewall rejected live coordination state')

  expectFailure('superseded-file', root => {
    const target = join(root, 'docs', '12-independent-review-management.md')
    writeFileSync(target, '# obsolete\n', 'utf8')
  }, 'superseded governance file must be deleted')

  expectFailure('false-worktree-backend', root => {
    mutate(root, 'docs/governance/project-binding.yaml', content => content.replace('backend: single-checkout', 'backend: git-worktree'))
  }, 'missing or changed declaration backend: single-checkout')

  expectFailure('registry-escape', root => {
    mutate(root, 'docs/governance/document-registry.yaml', content => `${content}\n  - documentId: escaped\n    path: ../../outside.md\n    role: stable-authority\n    subject: governance\n    writeMode: human\n`)
  }, 'path escapes the project root')

  console.log('Governance gate positive fixture and 8 negative policy cases: PASS')
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}
