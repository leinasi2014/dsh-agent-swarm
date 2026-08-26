import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const sourceScripts = resolve('scripts')
const fixtureRoot = mkdtempSync(join(tmpdir(), 'dsh-isolation-lifecycle-'))
const repo = join(fixtureRoot, 'repo')
let cli

function git(args, cwd = repo) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5_000,
    windowsHide: true,
  }).trim()
}

function run(args, cwd = repo) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    env: { ...process.env, DSH_ISOLATION_TEST_LOCK_TIMEOUT: '100' },
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  })
  if (result.status === null) throw new Error(`lifecycle child timed out: ${args.join(' ')}`)
  return result
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

function resultJson(args, cwd = repo) {
  const result = run([...args, '--json'], cwd)
  return JSON.parse(result.stdout)
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
  writeFileSync(join(repo, '.gitignore'), '/.worktree/\n/scripts/\n')
  writeFileSync(join(repo, 'README.md'), '# fixture\n')
  git(['add', '.'])
  git(['commit', '--no-gpg-sign', '-m', 'test: initial'])
  mkdirSync(join(repo, 'scripts'))
  for (const name of ['worktree-lifecycle.mjs', 'worktree-lifecycle-core.mjs', 'worktree-lifecycle-proof.mjs', 'worktree-lifecycle-lock.mjs']) copyFileSync(join(sourceScripts, name), join(repo, 'scripts', name))
  cli = join(repo, 'scripts', 'worktree-lifecycle.mjs')

  const initial = json(['status'])
  if (!initial.healthy || initial.allocations.length !== 0) throw new Error('empty authority must be healthy')

  const externalScripts = join(fixtureRoot, 'candidate-scripts')
  mkdirSync(externalScripts)
  for (const name of ['worktree-lifecycle.mjs', 'worktree-lifecycle-core.mjs', 'worktree-lifecycle-proof.mjs', 'worktree-lifecycle-lock.mjs']) copyFileSync(join(sourceScripts, name), join(externalScripts, name))
  const external = spawnSync(process.execPath, [join(externalScripts, 'worktree-lifecycle.mjs'), 'open', '--id', 'external-code', '--branch', 'test/external-code', '--owner', 'writer-x'], { cwd: repo, encoding: 'utf8', timeout: 5_000, windowsHide: true })
  if (external.status === 0 || !`${external.stdout}\n${external.stderr}`.includes('MUTATION_REQUIRES_PRIMARY')) throw new Error('primary cwd must reject lifecycle code loaded outside the primary source root')

  writeFileSync(join(repo, 'primary-dirty.txt'), 'dirty\n')
  expectFailure('dirty primary rejects mutation before lock acquisition', ['open', '--id', 'dirty-primary', '--branch', 'test/dirty-primary', '--owner', 'writer-a'], 'PRIMARY_DIRTY')
  if (existsSync(join(resolve(repo, git(['rev-parse', '--git-common-dir'])), 'dsh-agent-swarm-isolation', 'v1', 'lock'))) throw new Error('rejected primary mutation left an authority lock')
  rmSync(join(repo, 'primary-dirty.txt'))

  expectFailure('invalid id', ['open', '--id', '../escape', '--branch', 'test/escape', '--owner', 'writer-a'], 'INVALID_ID')
  expectFailure('windows reserved filename', ['open', '--id', 'con.txt', '--branch', 'test/con', '--owner', 'writer-a'], 'INVALID_ID')
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
  if (archived.state !== 'CLOSED' || archived.outcome !== 'archived' || archived.archiveRef !== 'refs/archive/alpha-2') throw new Error('archive close did not persist archive proof')
  git(['update-ref', 'refs/archive/alpha-2', 'HEAD'])
  expectFailure('closed archive ref must remain durable', ['status'], 'OUTCOME_UNPROVEN')
  git(['update-ref', 'refs/archive/alpha-2', archiveCandidate])

  const beta = json(['open', '--id', 'beta', '--branch', 'test/beta', '--owner', 'writer-b'])
  expectFailure('writer cannot load lifecycle mutation from its own checkout', ['close', '--id', 'beta', '--generation', String(beta.generation), '--owner', 'writer-b', '--outcome', 'integrated'], 'MUTATION_REQUIRES_PRIMARY', beta.path)
  const gamma = json(['open', '--id', 'gamma', '--branch', 'test/gamma', '--owner', 'writer-c'])
  expectFailure('writer capacity', ['open', '--id', 'delta', '--branch', 'test/delta', '--owner', 'writer-d'], 'CAPACITY_EXCEEDED')
  const deltaPath = join(repo, '.worktree', 'delta')
  git(['worktree', 'add', deltaPath, '-b', 'test/delta'])
  const overCapacity = JSON.parse(readFileSync(authorityStatePath(), 'utf8'))
  overCapacity.allocations.delta = {
    id: 'delta', generation: 1, state: 'ACTIVE', owner: 'writer-d', base: git(['rev-parse', 'HEAD']),
    branch: 'test/delta', path: deltaPath, candidate: null, outcome: null, archiveRef: null, integrationHead: null, result: 'opened', updatedAt: new Date().toISOString(),
  }
  writeFileSync(authorityStatePath(), `${JSON.stringify(overCapacity, null, 2)}\n`)
  expectFailure('observed over-capacity state', ['status'], 'CAPACITY_EXCEEDED')
  git(['worktree', 'remove', deltaPath])
  git(['branch', '-D', 'test/delta'])
  delete overCapacity.allocations.delta
  writeFileSync(authorityStatePath(), `${JSON.stringify(overCapacity, null, 2)}\n`)
  json(['close', '--id', 'gamma', '--generation', String(gamma.generation), '--owner', 'writer-c', '--outcome', 'integrated'])
  const statePath = authorityStatePath()
  const state = JSON.parse(readFileSync(statePath, 'utf8'))
  state.allocations.beta.state = 'OPENING'
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`)
  expectFailure('transitional status is not healthy', ['status'], 'RESULT_UNKNOWN')
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

  const managedContainer = join(repo, '.worktree')
  const escapedContainer = join(fixtureRoot, 'escaped-container')
  renameSync(managedContainer, escapedContainer)
  symlinkSync(escapedContainer, managedContainer, process.platform === 'win32' ? 'junction' : 'dir')
  expectFailure('junction container escapes the primary checkout', ['status'], 'PATH_ESCAPE')
  expectFailure('junction container reconcile is unsafe', ['reconcile'], 'UNMANAGED')
  rmSync(managedContainer, { recursive: true, force: true })
  renameSync(escapedContainer, managedContainer)

  const escapedBeta = join(fixtureRoot, 'escaped-beta')
  renameSync(beta.path, escapedBeta)
  symlinkSync(escapedBeta, beta.path, process.platform === 'win32' ? 'junction' : 'dir')
  expectFailure('junction allocation escapes the managed container', ['status'], 'PATH_ESCAPE')
  rmSync(beta.path, { recursive: true, force: true })
  renameSync(escapedBeta, beta.path)

  const rawDirectory = join(repo, '.worktree', 'raw-dir')
  mkdirSync(rawDirectory)
  expectFailure('unregistered directory status', ['status'], 'RAW_WORKTREE_DETECTED')
  expectFailure('unregistered directory reconcile', ['reconcile'], 'UNMANAGED')
  expectFailure('unregistered directory freezes open', ['open', '--id', 'delta', '--branch', 'test/delta', '--owner', 'writer-d'], 'RAW_WORKTREE_DETECTED')
  expectFailure('unregistered directory freezes close', ['close', '--id', 'beta', '--generation', String(beta.generation), '--owner', 'writer-b', '--outcome', 'integrated'], 'RAW_WORKTREE_DETECTED')
  rmSync(rawDirectory, { recursive: true })

  const raw = join(repo, '.worktree', 'raw')
  git(['worktree', 'add', raw, '-b', 'test/raw'])
  expectFailure('raw worktree', ['status'], 'RAW_WORKTREE_DETECTED')
  git(['worktree', 'remove', raw])
  git(['branch', '-D', 'test/raw'])

  const lockPath = join(resolve(repo, git(['rev-parse', '--git-common-dir'])), 'dsh-agent-swarm-isolation', 'v1', 'lock')
  writeFileSync(lockPath, 'not-json\n')
  expectFailure('busy authority lock', ['close', '--id', 'beta', '--generation', String(beta.generation), '--owner', 'writer-b', '--outcome', 'integrated'], 'LOCK_BUSY')
  expectFailure('ownerless lock is not broken', ['reconcile', '--recover-lock'], 'LOCK_OWNER_UNKNOWN')
  rmSync(lockPath, { recursive: true })

  writeFileSync(lockPath, `${JSON.stringify({ schemaVersion: 1, hostname: hostname(), pid: 2_147_483_647, startedAt: new Date(0).toISOString(), nonce: 'dead-owner' })}\n`)
  const recoveredLock = json(['reconcile', '--recover-lock'])
  if (recoveredLock.recovered !== true) throw new Error('proved-dead lock was not recovered')

  git(['worktree', 'remove', beta.path])
  expectFailure('missing ACTIVE allocation freezes open', ['open', '--id', 'delta', '--branch', 'test/delta', '--owner', 'writer-d'], 'ALLOCATION_DRIFT')
  expectFailure('missing ACTIVE allocation status', ['status'], 'ALLOCATION_DRIFT')
  expectFailure('ambiguous repair', ['reconcile', '--repair'], 'REPAIR_UNSAFE')
  expectFailure('unknown freezes open', ['open', '--id', 'delta', '--branch', 'test/delta', '--owner', 'writer-d'], 'RESULT_UNKNOWN')
  const classified = JSON.parse(readFileSync(statePath, 'utf8'))
  if (classified.allocations.beta.state !== 'UNKNOWN') throw new Error('unsafe reconcile did not persist UNKNOWN classification')

  git(['update-ref', '-d', 'refs/archive/alpha-2'])
  expectFailure('closed archive evidence drift status', ['status'], 'RESULT_UNKNOWN')
  const closedPreview = resultJson(['reconcile'])
  if (!closedPreview.actions.some(action => action.id === 'alpha' && action.from === 'CLOSED' && action.to === 'UNKNOWN')) throw new Error('closed archive evidence drift was not classified UNKNOWN')
  expectFailure('closed archive evidence drift repair', ['reconcile', '--repair'], 'REPAIR_UNSAFE')
  const closedClassified = JSON.parse(readFileSync(statePath, 'utf8')).allocations.alpha
  if (closedClassified.state !== 'UNKNOWN' || closedClassified.candidate !== archiveCandidate || closedClassified.outcome !== 'archived' || closedClassified.archiveRef !== 'refs/archive/alpha-2') {
    throw new Error('UNKNOWN must preserve non-authoritative archive recovery evidence')
  }

  const closingState = JSON.parse(readFileSync(statePath, 'utf8'))
  closingState.allocations.alpha.state = 'CLOSING'
  writeFileSync(statePath, `${JSON.stringify(closingState, null, 2)}\n`)
  const closingPreview = resultJson(['reconcile'])
  if (!closingPreview.actions.some(action => action.id === 'alpha' && action.from === 'CLOSING' && action.to === 'UNKNOWN')) throw new Error('closing archive evidence drift was not classified UNKNOWN')
  expectFailure('closing archive evidence drift repair', ['reconcile', '--repair'], 'REPAIR_UNSAFE')
  const closingClassified = JSON.parse(readFileSync(statePath, 'utf8')).allocations.alpha
  if (closingClassified.state !== 'UNKNOWN' || closingClassified.candidate !== archiveCandidate || closingClassified.outcome !== 'archived' || closingClassified.archiveRef !== 'refs/archive/alpha-2') {
    throw new Error('CLOSING recovery evidence was lost while freezing UNKNOWN')
  }
  expectFailure('repaired evidence drift remains fail-closed', ['status'], 'RESULT_UNKNOWN')
  console.log('Project-owned isolation lifecycle: positive open/close/archive/recovery and 33 negative cases: PASS')
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true })
}
