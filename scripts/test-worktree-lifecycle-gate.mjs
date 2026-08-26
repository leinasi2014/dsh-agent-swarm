import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const cli = resolve('scripts/worktree-lifecycle.mjs')
const fixtureRoot = mkdtempSync(join(tmpdir(), 'dsh-isolation-lifecycle-'))
const repo = join(fixtureRoot, 'repo')

function git(args, cwd = repo) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
    windowsHide: true,
  }).trim()
}

function run(args, cwd = repo) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  })
}

function expectSuccess(label, args, cwd = repo) {
  const result = run(args, cwd)
  if (result.status !== 0) throw new Error(`${label}: expected success\n${result.stdout}\n${result.stderr}`)
  return result
}

function expectFailure(label, args, code, cwd = repo) {
  const result = run(args, cwd)
  const output = `${result.stdout}\n${result.stderr}`
  if (result.status === 0 || !output.includes(code)) throw new Error(`${label}: expected ${code}\n${output}`)
}

function json(args, cwd = repo) {
  return JSON.parse(expectSuccess(args.join(' '), [...args, '--json'], cwd).stdout)
}

function authorityStatePath() {
  const common = resolve(repo, git(['rev-parse', '--git-common-dir']))
  return join(common, 'dsh-agent-swarm-isolation', 'v1', 'state.json')
}

try {
  mkdirSync(repo)
  git(['init', '-b', 'main'])
  git(['config', 'user.email', 'lifecycle-test@example.invalid'])
  git(['config', 'user.name', 'Lifecycle Test'])
  git(['config', 'dsh-agent-swarm.integration-ref', 'main'])
  writeFileSync(join(repo, '.gitignore'), '/.worktree/\n')
  writeFileSync(join(repo, 'README.md'), '# fixture\n')
  git(['add', '.'])
  git(['commit', '--no-gpg-sign', '-m', 'test: initial'])

  const initial = json(['status'])
  if (!initial.healthy || initial.allocations.length !== 0) throw new Error('empty authority must be healthy')

  expectFailure('invalid id', ['open', '--id', '../escape', '--branch', 'test/escape', '--owner', 'writer-a'], 'INVALID_ID')
  expectFailure('invalid branch', ['open', '--id', 'bad-branch', '--branch', '-bad', '--owner', 'writer-a'], 'INVALID_BRANCH')
  const first = json(['open', '--id', 'alpha', '--branch', 'test/alpha', '--owner', 'writer-a'])
  if (first.state !== 'ACTIVE' || first.generation !== 1 || first.owner !== 'writer-a') throw new Error('open did not publish ACTIVE generation 1')
  expectFailure('duplicate allocation', ['open', '--id', 'alpha', '--branch', 'test/alpha-2', '--owner', 'writer-a'], 'ALLOCATION_EXISTS')
  expectFailure('stale generation', ['close', '--id', 'alpha', '--generation', '2', '--owner', 'writer-a', '--outcome', 'integrated'], 'STALE_GENERATION')
  expectFailure('owner mismatch', ['close', '--id', 'alpha', '--generation', '1', '--owner', 'writer-b', '--outcome', 'integrated'], 'OWNER_MISMATCH')

  writeFileSync(join(first.path, 'alpha.txt'), 'alpha\n')
  expectFailure('dirty close', ['close', '--id', 'alpha', '--generation', '1', '--owner', 'writer-a', '--outcome', 'integrated'], 'DIRTY_OR_UNTRACKED')
  git(['add', 'alpha.txt'], first.path)
  git(['commit', '--no-gpg-sign', '-m', 'feat: alpha'], first.path)
  expectFailure('unproven close', ['close', '--id', 'alpha', '--generation', '1', '--owner', 'writer-a', '--outcome', 'integrated'], 'OUTCOME_UNPROVEN')
  const alphaCandidate = git(['rev-parse', 'HEAD'], first.path)
  git(['cherry-pick', alphaCandidate])
  const closed = json(['close', '--id', 'alpha', '--generation', '1', '--owner', 'writer-a', '--outcome', 'integrated'])
  if (closed.state !== 'CLOSED' || closed.candidate !== alphaCandidate) throw new Error('integrated close did not preserve candidate identity')
  expectFailure('retained branch cannot be reclaimed', ['open', '--id', 'branch-clash', '--branch', 'test/alpha', '--owner', 'writer-c'], 'BRANCH_EXISTS')

  const second = json(['open', '--id', 'alpha', '--branch', 'test/alpha-archive', '--owner', 'writer-a'])
  if (second.generation !== 2) throw new Error('reopened allocation did not increment generation')
  writeFileSync(join(second.path, 'archive.txt'), 'archive\n')
  git(['add', 'archive.txt'], second.path)
  git(['commit', '--no-gpg-sign', '-m', 'feat: archived candidate'], second.path)
  const archiveCandidate = git(['rev-parse', 'HEAD'], second.path)
  git(['update-ref', 'refs/archive/alpha-2', archiveCandidate])
  expectFailure('wrong archive ref', ['close', '--id', 'alpha', '--generation', '2', '--owner', 'writer-a', '--outcome', 'archived', '--archive-ref', 'refs/archive/missing'], 'OUTCOME_UNPROVEN')
  const archived = json(['close', '--id', 'alpha', '--generation', '2', '--owner', 'writer-a', '--outcome', 'archived', '--archive-ref', 'refs/archive/alpha-2'])
  if (archived.state !== 'CLOSED' || archived.outcome !== 'archived') throw new Error('archive close failed')

  const beta = json(['open', '--id', 'beta', '--branch', 'test/beta', '--owner', 'writer-b'])
  const gamma = json(['open', '--id', 'gamma', '--branch', 'test/gamma', '--owner', 'writer-c'])
  expectFailure('writer capacity', ['open', '--id', 'delta', '--branch', 'test/delta', '--owner', 'writer-d'], 'CAPACITY_EXCEEDED')
  json(['close', '--id', 'gamma', '--generation', String(gamma.generation), '--owner', 'writer-c', '--outcome', 'integrated'])
  const statePath = authorityStatePath()
  const state = JSON.parse(readFileSync(statePath, 'utf8'))
  state.allocations.beta.state = 'OPENING'
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`)
  const preview = json(['reconcile'])
  if (preview.actions[0]?.to !== 'ACTIVE') throw new Error('read-only reconcile did not identify deterministic OPENING repair')
  const unchanged = JSON.parse(readFileSync(statePath, 'utf8'))
  if (unchanged.allocations.beta.state !== 'OPENING') throw new Error('read-only reconcile mutated authority')
  const repaired = json(['reconcile', '--repair'])
  if (repaired.actions[0]?.to !== 'ACTIVE') throw new Error('repair did not activate deterministic OPENING allocation')

  const validState = readFileSync(statePath, 'utf8')
  const corrupt = JSON.parse(validState)
  corrupt.allocations.beta.generation = 0
  writeFileSync(statePath, `${JSON.stringify(corrupt, null, 2)}\n`)
  expectFailure('corrupt allocation schema', ['status'], 'AUTHORITY_CORRUPT')
  writeFileSync(statePath, validState)

  const raw = join(repo, '.worktree', 'raw')
  git(['worktree', 'add', raw, '-b', 'test/raw'])
  expectFailure('raw worktree', ['status'], 'RAW_WORKTREE_DETECTED')
  git(['worktree', 'remove', raw])
  git(['branch', '-D', 'test/raw'])

  const lockPath = join(resolve(repo, git(['rev-parse', '--git-common-dir'])), 'dsh-agent-swarm-isolation', 'v1', 'lock')
  mkdirSync(lockPath)
  expectFailure('busy authority lock', ['close', '--id', 'beta', '--generation', String(beta.generation), '--owner', 'writer-b', '--outcome', 'integrated'], 'LOCK_BUSY')
  rmSync(lockPath, { recursive: true })

  const ambiguous = JSON.parse(readFileSync(statePath, 'utf8'))
  ambiguous.allocations.beta.state = 'UNKNOWN'
  writeFileSync(statePath, `${JSON.stringify(ambiguous, null, 2)}\n`)
  expectFailure('unknown freezes open', ['open', '--id', 'delta', '--branch', 'test/delta', '--owner', 'writer-d'], 'RESULT_UNKNOWN')
  expectFailure('ambiguous repair', ['reconcile', '--repair'], 'REPAIR_UNSAFE')
  const classified = JSON.parse(readFileSync(statePath, 'utf8'))
  if (classified.allocations.beta.state !== 'UNKNOWN') throw new Error('unsafe reconcile did not persist UNKNOWN classification')
  console.log('Project-owned isolation lifecycle: 1 positive lifecycle and 15 negative/recovery cases: PASS')
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true })
}
