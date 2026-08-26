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
  for (const item of ['.agents', 'AGENTS.md', 'CLAUDE.md', 'CONTRIBUTING.md', 'README.md', 'LICENSE', 'docs']) {
    cpSync(join(sourceRoot, item), join(root, item), { recursive: true })
  }
  return root
}

function run(root, skipGit = true) {
  return spawnSync(process.execPath, [verifier, '--root', root, ...(skipGit ? ['--skip-git'] : [])], {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  })
}

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 30_000, windowsHide: true })
  if (result.status !== 0) throw new Error(`git fixture command failed: ${args[0]}`)
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
    mutate(root, 'docs/governance/project-binding.yaml', content => content.replace('backend: git-worktree', 'backend: single-checkout'))
  }, 'missing or changed declaration backend: git-worktree')

  expectFailure('invalid-policy-digest', root => {
    mutate(root, 'docs/governance/project-binding.yaml', content => content.replace(/policyDigest: [0-9a-f]{40}/u, 'policyDigest: latest'))
  }, 'method policyDigest must be one lowercase 40-hex commit identity')

  expectFailure('project-global-lane', root => {
    mutate(root, 'docs/governance/project-binding.yaml', content => content.replace('  integrationRef:', '  deliveryLane: S2-contracted\n  integrationRef:'))
  }, 'a project-global deliveryLane is forbidden')

  expectFailure('candidate-self-activation', root => {
    mutate(root, 'docs/governance/project-binding.yaml', content => content.replace('candidateSelfActivation: forbidden', 'candidateSelfActivation: allowed'))
  }, 'missing or changed declaration candidateSelfActivation: forbidden')

  expectFailure('retired-accepted-base-bridge', root => {
    mutate(root, 'docs/governance/project-binding.yaml', content => `${content}\nacceptedBaseVerifierBridge:\n  acceptedVerifierAuthorityEpoch: 2\n`)
  }, 'retired accepted-base verifier bridge is forbidden')

  expectFailure('retired-single-checkout-declaration', root => {
    mutate(root, 'docs/governance/project-binding.yaml', content => `${content}\nlegacyIsolationDeclarations:\n  backend: single-checkout\n`)
  }, 'retired single-checkout isolation declaration is forbidden')

  expectFailure('missing-pipeline-direction-owner', root => {
    mutate(root, 'docs/governance/project-binding.yaml', content => content.replace('projectDirectionOwner: product-and-architecture-owner', 'projectDirectionOwner: missing'))
  }, 'missing or changed declaration projectDirectionOwner: product-and-architecture-owner')

  expectFailure('missing-accountable-owner', root => {
    mutate(root, 'docs/governance/document-registry.yaml', content => content.replace('    accountableOwner: governance-owner\n', ''))
  }, 'incomplete document entry project-binding')

  expectFailure('illegal-role', root => {
    mutate(root, 'docs/governance/document-registry.yaml', content => content.replace('    role: stable-authority', '    role: instruction-adapter'))
  }, 'illegal role instruction-adapter')

  expectFailure('projection-refresh-contract', root => {
    mutate(root, 'docs/governance/document-registry.yaml', content => content.replace('    refreshPolicy: same-candidate-as-source-change\n', ''))
  }, 'projection root-agent-instructions requires sourceAuthority, refreshPolicy, and expiryPolicy')

  expectFailure('projection-source-authority', root => {
    mutate(root, 'docs/governance/document-registry.yaml', content => content.replace('    sourceAuthority: project-binding', '    sourceAuthority: missing-authority'))
  }, 'references unknown sourceAuthority missing-authority')

  {
    const root = copyFixture('credential-bearing-remote')
    git(root, ['init'])
    git(root, ['config', 'user.name', 'Governance Fixture'])
    git(root, ['config', 'user.email', 'fixture@example.invalid'])
    git(root, ['add', '.'])
    git(root, ['commit', '--no-gpg-sign', '-m', 'fixture'])
    git(root, ['remote', 'add', 'origin', 'https://example.invalid/authority.git'])
    git(root, ['remote', 'add', 'github', 'https://example.invalid/mirror.git'])
    const secretUserInfo = 'embedded-user'
    const secretPushUrl = `https://${secretUserInfo}@example.invalid/authority.git`
    git(root, ['remote', 'set-url', '--add', '--push', 'origin', secretPushUrl])
    const result = run(root, false)
    const output = `${result.stdout}\n${result.stderr}`
    if (result.status === 0 || !output.includes('remote origin: credential or userinfo in URL is forbidden')) {
      throw new Error(`credential-bearing-remote: expected redacted remote credential failure, got status ${result.status}`)
    }
    if (output.includes(secretPushUrl) || output.includes(secretUserInfo)) {
      throw new Error('credential-bearing-remote: verifier output exposed push URL userinfo')
    }
  }

  expectFailure('registry-escape', root => {
    mutate(root, 'docs/governance/document-registry.yaml', content => `${content}\n  - documentId: escaped\n    path: ../../outside.md\n    role: stable-authority\n    subject: governance\n    writeMode: human\n    accountableOwner: governance-owner\n    mutationAuthority: expected-target-reviewed-candidate\n    updateTriggers: test\n    validation: pnpm-verify-governance\n`)
  }, 'path escapes the project root')

  console.log('Governance gate positive fixture and 19 negative policy cases: PASS')
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}
