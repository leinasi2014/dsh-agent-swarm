import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { integrationProof, outcomeStillProven } from './worktree-lifecycle-proof.mjs'
import { recoverDeadLock, withAuthorityLock as locked } from './worktree-lifecycle-lock.mjs'
const coreSourceRoot = realpathSync(resolve(fileURLToPath(new URL('..', import.meta.url))))
export class LifecycleError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'LifecycleError'
    this.code = code
  }
}
function git(args, cwd, optional = false) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
      windowsHide: true,
    }).trim()
  } catch (error) {
    if (optional) return ''
    throw new LifecycleError('GIT_FAILED', `git ${args[0]} failed: ${String(error.stderr ?? error.message).trim()}`)
  }
}
function gitSucceeds(args, cwd) {
  try {
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 30_000,
      windowsHide: true,
    })
    return true
  } catch {
    return false
  }
}
function comparable(path) {
  const normalized = resolve(path).replaceAll('\\', '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}
function directChild(parent, child) {
  const rel = relative(parent, child)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) && !rel.includes(sep)
}
export function discoverRepository(cwd = process.cwd()) {
  const currentRoot = realpathSync(resolve(git(['rev-parse', '--show-toplevel'], cwd)))
  const records = parseWorktrees(git(['worktree', 'list', '--porcelain', '-z'], currentRoot))
  if (records.length === 0) throw new LifecycleError('AUTHORITY_CORRUPT', 'git returned no primary worktree')
  const primaryRoot = realpathSync(resolve(records[0].path))
  const commonDir = realpathSync(resolve(currentRoot, git(['rev-parse', '--git-common-dir'], currentRoot)))
  const authorityRoot = join(commonDir, 'dsh-agent-swarm-isolation', 'v1')
  return {
    currentRoot,
    primaryRoot,
    commonDir,
    authorityRoot,
    statePath: join(authorityRoot, 'state.json'),
    lockPath: join(authorityRoot, 'lock'),
    worktreeRoot: join(primaryRoot, '.worktree'),
  }
}
export function parseWorktrees(output) {
  if (output.includes('\0')) {
    const records = []
    let current
    for (const field of output.split('\0').filter(Boolean)) {
      if (field.startsWith('worktree ')) {
        if (current) records.push(current)
        current = { path: field.slice(9), head: '', branch: undefined, detached: false }
      } else if (current && field.startsWith('HEAD ')) current.head = field.slice(5)
      else if (current && field.startsWith('branch refs/heads/')) current.branch = field.slice(18)
      else if (current && field === 'detached') current.detached = true
    }
    if (current) records.push(current)
    return records
  }
  return output.trim().split(/\r?\n\r?\n/u).filter(Boolean).map(block => ({
    path: block.match(/^worktree (.+)$/mu)?.[1] ?? '',
    head: block.match(/^HEAD ([0-9a-f]+)$/mu)?.[1] ?? '',
    branch: block.match(/^branch refs\/heads\/(.+)$/mu)?.[1],
    detached: /^detached$/mu.test(block),
  }))
}
function emptyState() {
  return {
    schemaVersion: 1,
    authorityEpoch: 3,
    revision: 0,
    allocations: {},
    history: {},
  }
}
export function readState(repository, { allowMissing = true } = {}) {
  if (!existsSync(repository.statePath)) {
    if (allowMissing) return emptyState()
    throw new LifecycleError('AUTHORITY_CORRUPT', 'isolation authority state is missing')
  }
  let state
  try {
    state = JSON.parse(readFileSync(repository.statePath, 'utf8'))
  } catch {
    throw new LifecycleError('AUTHORITY_CORRUPT', 'isolation authority state is not valid JSON')
  }
  if (state?.schemaVersion !== 1 || state?.authorityEpoch !== 3 || !Number.isInteger(state?.revision) || state.revision < 0 || typeof state?.allocations !== 'object' || state.allocations === null || Array.isArray(state.allocations) || typeof state?.history !== 'object' || state.history === null || Array.isArray(state.history)) {
    throw new LifecycleError('AUTHORITY_CORRUPT', 'isolation authority state has an unsupported schema')
  }
  for (const [id, allocation] of Object.entries(state.allocations)) {
    const valid = allocation?.id === id
      && /^[a-z0-9][a-z0-9._-]*$/u.test(id)
      && Number.isInteger(allocation.generation) && allocation.generation > 0
      && ['OPENING', 'ACTIVE', 'CLOSING', 'CLOSED', 'ABORTED', 'UNKNOWN'].includes(allocation.state)
      && typeof allocation.owner === 'string' && allocation.owner !== ''
      && typeof allocation.base === 'string' && /^[0-9a-f]{40}$/u.test(allocation.base)
      && typeof allocation.branch === 'string' && allocation.branch !== ''
      && typeof allocation.path === 'string' && isAbsolute(allocation.path)
      && (allocation.candidate === null || (typeof allocation.candidate === 'string' && /^[0-9a-f]{40}$/u.test(allocation.candidate)))
      && (allocation.outcome === null || ['integrated', 'archived'].includes(allocation.outcome))
      && (allocation.archiveRef === null || (typeof allocation.archiveRef === 'string' && allocation.archiveRef.startsWith('refs/archive/')))
      && (allocation.integrationHead === null || /^[0-9a-f]{40}$/u.test(allocation.integrationHead))
      && typeof allocation.result === 'string'
      && typeof allocation.updatedAt === 'string'
    if (!valid) throw new LifecycleError('AUTHORITY_CORRUPT', `allocation ${id} has an unsupported schema`)
    const settled = ['CLOSING', 'CLOSED'].includes(allocation.state)
    const current = ['OPENING', 'ACTIVE', 'ABORTED'].includes(allocation.state)
    if ((settled && (allocation.candidate === null || allocation.outcome === null))
      || (current && (allocation.candidate !== null || allocation.outcome !== null || allocation.archiveRef !== null || allocation.integrationHead !== null))
      || ((allocation.candidate === null) !== (allocation.outcome === null))
      || (allocation.outcome === 'archived' && allocation.archiveRef === null)
      || (allocation.outcome !== 'archived' && allocation.archiveRef !== null)
      || (allocation.outcome === 'integrated' && allocation.integrationHead === null)
      || (allocation.outcome !== 'integrated' && allocation.integrationHead !== null)) {
      throw new LifecycleError('AUTHORITY_CORRUPT', `allocation ${id} has inconsistent disposition evidence`)
    }
  }
  for (const [id, entries] of Object.entries(state.history)) {
    if (!Array.isArray(entries) || entries.some(entry => entry?.id !== id || !Number.isInteger(entry.generation) || entry.generation < 1
      || !['CLOSED', 'ABORTED', 'UNKNOWN'].includes(entry.state) || !/^[0-9a-f]{40}$/u.test(entry.base) || typeof entry.branch !== 'string'
      || typeof entry.path !== 'string' || !isAbsolute(entry.path) || typeof entry.result !== 'string' || typeof entry.updatedAt !== 'string'
      || (entry.state === 'ABORTED' ? entry.candidate !== null || entry.outcome !== null || entry.archiveRef !== null || entry.integrationHead !== null
        : !/^[0-9a-f]{40}$/u.test(entry.candidate) || !['integrated', 'archived'].includes(entry.outcome)
          || (entry.outcome === 'archived' ? typeof entry.archiveRef !== 'string' || !entry.archiveRef.startsWith('refs/archive/') : entry.archiveRef !== null)
          || (entry.outcome === 'integrated' ? !/^[0-9a-f]{40}$/u.test(entry.integrationHead) : entry.integrationHead !== null)))) {
      throw new LifecycleError('AUTHORITY_CORRUPT', `history ${id} has an unsupported schema`)
    }
  }
  const active = Object.values(state.allocations).filter(allocation => activeAllocation(allocation))
  const activePaths = new Set(active.map(allocation => comparable(allocation.path)))
  const activeBranches = new Set(active.map(allocation => allocation.branch))
  if (activePaths.size !== active.length || activeBranches.size !== active.length) {
    throw new LifecycleError('AUTHORITY_CORRUPT', 'active allocations contain duplicate path or branch ownership')
  }
  return state
}
function writeState(repository, state) {
  mkdirSync(repository.authorityRoot, { recursive: true })
  const next = { ...state, revision: state.revision + 1 }
  const temporary = join(repository.authorityRoot, `.state-${process.pid}-${randomUUID()}.tmp`)
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  renameSync(temporary, repository.statePath)
  return next
}
export function withAuthorityLock(repository, callback, timeoutMilliseconds = 2_000) {
  mkdirSync(repository.authorityRoot, { recursive: true })
  const testTimeout = Number(process.env.DSH_ISOLATION_TEST_LOCK_TIMEOUT)
  return locked(repository, callback, LifecycleError, Number.isInteger(testTimeout) && testTimeout > 0 ? testTimeout : timeoutMilliseconds)
}
export function recoverAuthorityLock({ cwd } = {}) {
  const repository = discoverRepository(cwd)
  requirePrimaryCaller(repository)
  const records = ensurePrimaryReady(repository)
  assertNoUnmanaged(repository, readState(repository), records)
  return recoverDeadLock(repository, LifecycleError)
}
function assertSlug(id) {
  const windowsReserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/u
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(id) || id.endsWith('.') || windowsReserved.test(id.split('.')[0])) {
    throw new LifecycleError('INVALID_ID', 'allocation id must be a portable stable lowercase slug')
  }
}
function assertBranch(branch) {
  if (branch === '' || branch.startsWith('-') || !gitSucceeds(['check-ref-format', '--branch', branch], process.cwd())) {
    throw new LifecycleError('INVALID_BRANCH', 'branch is not a valid Git branch name')
  }
}
function primaryFacts(repository) {
  const records = parseWorktrees(git(['worktree', 'list', '--porcelain', '-z'], repository.primaryRoot))
  const primary = records[0]
  if (primary === undefined || comparable(realpathSync(resolve(primary.path))) !== comparable(repository.primaryRoot)) {
    throw new LifecycleError('AUTHORITY_CORRUPT', 'the first registered worktree is not the primary checkout')
  }
  return { records, primary }
}
function requireClean(path, code = 'DIRTY_OR_UNTRACKED') {
  if (git(['status', '--porcelain', '--untracked-files=all'], path) !== '') {
    throw new LifecycleError(code, `checkout is dirty or has untracked files: ${path}`)
  }
}
function integrationBranch() {
  return 'main'
}

function ensurePrimaryReady(repository) {
  const { records, primary } = primaryFacts(repository)
  const expected = integrationBranch(repository)
  if (primary.branch !== expected) throw new LifecycleError('PRIMARY_NOT_INTEGRATION_REF', `primary checkout must be on ${expected}`)
  requireClean(repository.primaryRoot, 'PRIMARY_DIRTY')
  return records
}

function requirePrimaryCaller(repository) {
  if (comparable(repository.currentRoot) !== comparable(repository.primaryRoot) || comparable(coreSourceRoot) !== comparable(repository.primaryRoot)) {
    throw new LifecycleError('MUTATION_REQUIRES_PRIMARY', 'lifecycle mutation must load from the accepted primary checkout')
  }
}

export function assertLifecycleCliSource({ cwd, sourceUrl }) {
  const repository = discoverRepository(cwd)
  requirePrimaryCaller(repository)
  const cliRoot = realpathSync(resolve(fileURLToPath(new URL('..', sourceUrl))))
  if (comparable(cliRoot) !== comparable(repository.primaryRoot)) {
    throw new LifecycleError('MUTATION_REQUIRES_PRIMARY', 'lifecycle CLI must load from the accepted primary checkout')
  }
}

function allocationPath(repository, id) {
  const path = resolve(repository.worktreeRoot, id)
  if (!directChild(repository.worktreeRoot, path)) throw new LifecycleError('PATH_ESCAPE', 'allocation path escapes .worktree')
  return path
}

function assertRealContainer(repository) {
  if (!existsSync(repository.worktreeRoot)) return
  const realContainer = realpathSync(repository.worktreeRoot)
  if (comparable(realContainer) !== comparable(repository.worktreeRoot) || !directChild(repository.primaryRoot, realContainer)) {
    throw new LifecycleError('PATH_ESCAPE', '.worktree must be a real direct child of the primary checkout')
  }
}

function assertNoUnmanaged(repository, state, records) {
  for (const allocation of Object.values(state.allocations)) {
    const observed = inspectAllocation(repository, allocation, records)
    if (observed.failures.length > 0) throw new LifecycleError(observed.failures[0], `allocation ${allocation.id} is drifted`)
  }
  for (const entries of Object.values(state.history)) for (const allocation of entries) {
    const observed = inspectAllocation(repository, allocation, records, true)
    if (observed.failures.length > 0) throw new LifecycleError(observed.failures[0], `history ${allocation.id}/${allocation.generation} is drifted`)
  }
  for (const record of records.slice(1)) {
    if (!Object.values(state.allocations).some(allocation => comparable(allocation.path) === comparable(record.path))) {
      throw new LifecycleError('RAW_WORKTREE_DETECTED', 'an unmanaged worktree blocks lifecycle mutation')
    }
  }
  if (!existsSync(repository.worktreeRoot)) return
  assertRealContainer(repository)
  for (const entry of readdirSync(repository.worktreeRoot, { withFileTypes: true })) {
    const path = join(repository.worktreeRoot, entry.name)
    if (!Object.values(state.allocations).some(allocation => comparable(allocation.path) === comparable(path))) {
      throw new LifecycleError('RAW_WORKTREE_DETECTED', 'an unmanaged directory blocks lifecycle mutation')
    }
  }
}

function withMutationLock(repository, callback) {
  requirePrimaryCaller(repository)
  ensurePrimaryReady(repository)
  return withAuthorityLock(repository, () => {
    const records = ensurePrimaryReady(repository)
    const state = readState(repository)
    return callback({ records, state })
  })
}

function nextGeneration(existing) {
  return existing === undefined ? 1 : existing.generation + 1
}

function activeAllocation(allocation) {
  return allocation.state === 'OPENING' || allocation.state === 'ACTIVE' || allocation.state === 'CLOSING' || allocation.state === 'UNKNOWN'
}

export function openAllocation({ cwd, id, branch, base, owner }) {
  assertSlug(id)
  assertBranch(branch)
  if (typeof owner !== 'string' || owner === '') throw new LifecycleError('INVALID_OWNER', 'allocation owner is required')
  const repository = discoverRepository(cwd)
  return withMutationLock(repository, ({ records, state: initialState }) => {
    let state = initialState
    if (Object.values(state.allocations).some(allocation => ['OPENING', 'CLOSING', 'UNKNOWN'].includes(allocation.state))) {
      throw new LifecycleError('RESULT_UNKNOWN', 'an incomplete or ambiguous allocation freezes new writer allocation until reconciliation')
    }
    if (Object.values(state.allocations).filter(allocation => activeAllocation(allocation)).length >= 2) {
      throw new LifecycleError('CAPACITY_EXCEEDED', 'the managed writer capacity is two active allocations')
    }
    assertNoUnmanaged(repository, state, records)
    const existing = state.allocations[id]
    if (existing !== undefined && activeAllocation(existing)) throw new LifecycleError('ALLOCATION_EXISTS', `allocation ${id} is already ${existing.state}`)
    if (records.some(record => record.branch === branch)) throw new LifecycleError('BRANCH_CLAIMED', `branch ${branch} is already checked out`)
    if (gitSucceeds(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], repository.primaryRoot)) {
      throw new LifecycleError('BRANCH_EXISTS', `branch ${branch} already exists; open requires a new branch`)
    }
    const expectedBase = git(['rev-parse', base ?? 'HEAD'], repository.primaryRoot)
    const primaryHead = git(['rev-parse', 'HEAD'], repository.primaryRoot)
    if (expectedBase !== primaryHead) throw new LifecycleError('BASE_MISMATCH', 'open base must equal the current integration HEAD')
    const path = allocationPath(repository, id)
    if (existsSync(path)) throw new LifecycleError('ALLOCATION_DRIFT', `allocation path already exists: ${path}`)
    const allocation = {
      id,
      generation: nextGeneration(existing),
      state: 'OPENING',
      owner,
      base: expectedBase,
      branch,
      path,
      candidate: null,
      outcome: null,
      archiveRef: null,
      integrationHead: null,
      result: 'intent-recorded',
      updatedAt: new Date().toISOString(),
    }
    const history = existing === undefined ? state.history : { ...state.history, [id]: [...(state.history[id] ?? []), existing] }
    state = writeState(repository, { ...state, history, allocations: { ...state.allocations, [id]: allocation } })
    try {
      mkdirSync(repository.worktreeRoot, { recursive: true })
      assertRealContainer(repository)
      git(['worktree', 'add', path, '-b', branch, expectedBase], repository.primaryRoot)
      const facts = parseWorktrees(git(['worktree', 'list', '--porcelain', '-z'], repository.primaryRoot))
      const created = facts.find(record => comparable(record.path) === comparable(path))
      if (created?.branch !== branch || created.head !== expectedBase) throw new LifecycleError('ALLOCATION_DRIFT', 'created worktree failed identity read-back')
      const active = { ...allocation, state: 'ACTIVE', result: 'opened', updatedAt: new Date().toISOString() }
      state = writeState(repository, { ...state, allocations: { ...state.allocations, [id]: active } })
      return active
    } catch (error) {
      throw error
    }
  })
}

function inspectAllocation(repository, allocation, records, historical = false) {
  const failures = []
  let pathExists = existsSync(allocation.path)
  const record = records.find(item => comparable(item.path) === comparable(allocation.path))
  if (allocation.path !== allocationPath(repository, allocation.id)) failures.push('PATH_ESCAPE')
  if (activeAllocation(allocation)) {
    if (!pathExists || record === undefined) failures.push('ALLOCATION_DRIFT')
    if (record?.branch !== allocation.branch) failures.push('BRANCH_CLAIMED')
    if (record?.detached) failures.push('ALLOCATION_DRIFT')
    if (pathExists) {
      try {
        assertRealContainer(repository)
        const realContainer = realpathSync(repository.worktreeRoot)
        const realAllocation = realpathSync(allocation.path)
        if (comparable(realAllocation) !== comparable(allocation.path) || !directChild(realContainer, realAllocation)) failures.push('PATH_ESCAPE')
        const common = realpathSync(resolve(allocation.path, git(['rev-parse', '--git-common-dir'], allocation.path)))
        if (comparable(common) !== comparable(repository.commonDir)) failures.push('FOREIGN_COMMON_DIR')
        const branchHead = git(['rev-parse', `refs/heads/${allocation.branch}`], allocation.path, true)
        if (branchHead === '' || branchHead !== record?.head) failures.push('BRANCH_CLAIMED')
        if (!gitSucceeds(['merge-base', '--is-ancestor', allocation.base, record?.head ?? ''], allocation.path)) failures.push('BASE_MISMATCH')
        if (allocation.candidate !== null && allocation.candidate !== record?.head) failures.push('ALLOCATION_DRIFT')
      } catch {
        failures.push('ALLOCATION_DRIFT')
      }
    }
  } else if (!historical && (pathExists || record !== undefined)) {
    failures.push('ALLOCATION_DRIFT')
  }
  if (['CLOSING', 'CLOSED'].includes(allocation.state) && !outcomeStillProven(repository, allocation)) {
    failures.push('OUTCOME_UNPROVEN')
  }
  return { ...allocation, pathExists, registered: record !== undefined, observedHead: record?.head ?? null, failures: [...new Set(failures)] }
}

function unlockedStatusReport({ cwd, requireHealthy = false } = {}) {
  const repository = discoverRepository(cwd)
  const state = readState(repository)
  const { records, primary } = primaryFacts(repository)
  const failures = []
  const expectedPrimaryBranch = integrationBranch(repository)
  if (primary.branch !== expectedPrimaryBranch) failures.push('PRIMARY_NOT_INTEGRATION_REF')
  const allocations = Object.values(state.allocations).map(allocation => inspectAllocation(repository, allocation, records))
  const history = Object.values(state.history).flat().map(allocation => inspectAllocation(repository, allocation, records, true))
  if (allocations.filter(allocation => activeAllocation(allocation)).length > 2) failures.push('CAPACITY_EXCEEDED')
  for (const allocation of allocations) {
    if (['OPENING', 'CLOSING', 'UNKNOWN'].includes(allocation.state)) failures.push('RESULT_UNKNOWN')
  }
  for (const record of records.slice(1)) {
    if (!allocations.some(allocation => comparable(allocation.path) === comparable(record.path))) failures.push('RAW_WORKTREE_DETECTED')
  }
  if (existsSync(repository.worktreeRoot)) try {
    assertRealContainer(repository)
    for (const entry of readdirSync(repository.worktreeRoot, { withFileTypes: true })) {
      const path = join(repository.worktreeRoot, entry.name)
      if (!allocations.some(allocation => comparable(allocation.path) === comparable(path))) failures.push('RAW_WORKTREE_DETECTED')
    }
  } catch (error) {
    failures.push(error instanceof LifecycleError ? error.code : 'PATH_ESCAPE')
  }
  for (const allocation of allocations) failures.push(...allocation.failures)
  for (const allocation of history) failures.push(...allocation.failures)
  const report = {
    schemaVersion: 1,
    authorityEpoch: state.authorityEpoch,
    revision: state.revision,
    primary: { path: repository.primaryRoot, branch: primary.branch ?? null, head: primary.head },
    allocations,
    history,
    healthy: failures.length === 0,
    failures: [...new Set(failures)],
  }
  if (requireHealthy && !report.healthy) throw new LifecycleError(report.failures[0] ?? 'ALLOCATION_DRIFT', 'isolation status is not healthy')
  return report
}

export function statusReport({ cwd, requireHealthy = false } = {}) {
  const repository = discoverRepository(cwd)
  return withAuthorityLock(repository, () => unlockedStatusReport({ cwd, requireHealthy }))
}

export function closeAllocation({ cwd, id, generation, owner, outcome, archiveRef }) {
  assertSlug(id)
  const repository = discoverRepository(cwd)
  if (!existsSync(repository.statePath)) throw new LifecycleError('AUTHORITY_CORRUPT', 'isolation authority state is missing')
  return withMutationLock(repository, ({ records, state: initialState }) => {
    let state = initialState
    assertNoUnmanaged(repository, state, records)
    const allocation = state.allocations[id]
    if (allocation === undefined || allocation.state !== 'ACTIVE') throw new LifecycleError('ALLOCATION_NOT_ACTIVE', `allocation ${id} is not ACTIVE`)
    if (Number(generation) !== allocation.generation) throw new LifecycleError('STALE_GENERATION', 'allocation generation does not match')
    if (typeof owner !== 'string' || owner === '' || owner !== allocation.owner) throw new LifecycleError('OWNER_MISMATCH', 'allocation owner does not match')
    const observed = inspectAllocation(repository, allocation, records)
    if (observed.failures.length > 0) throw new LifecycleError(observed.failures[0], 'allocation identity does not match the authority ledger')
    requireClean(allocation.path)
    const candidate = git(['rev-parse', 'HEAD'], allocation.path)
    let persistedArchiveRef = null
    let integrationHead = null
    if (outcome === 'archived') {
      if (!archiveRef) throw new LifecycleError('OUTCOME_UNPROVEN', 'archived close requires --archive-ref')
      persistedArchiveRef = archiveRef
    } else if (outcome !== 'integrated') {
      throw new LifecycleError('OUTCOME_UNPROVEN', 'close outcome must be integrated or archived')
    }
    if (outcome === 'integrated') integrationHead = integrationProof(repository, allocation.base, candidate)
    const disposition = { ...allocation, candidate, outcome, archiveRef: persistedArchiveRef, integrationHead }
    if (outcome === 'integrated' ? integrationHead === null : !outcomeStillProven(repository, disposition)) {
      throw new LifecycleError('OUTCOME_UNPROVEN', 'candidate disposition is not proven by integration or durable archive')
    }
    const closing = { ...disposition, state: 'CLOSING', result: 'close-intent-recorded', updatedAt: new Date().toISOString() }
    state = writeState(repository, { ...state, allocations: { ...state.allocations, [id]: closing } })
    try {
      git(['worktree', 'remove', allocation.path], repository.primaryRoot)
      const remaining = parseWorktrees(git(['worktree', 'list', '--porcelain', '-z'], repository.primaryRoot))
      if (existsSync(allocation.path) || remaining.some(record => comparable(record.path) === comparable(allocation.path))) {
        throw new LifecycleError('ALLOCATION_DRIFT', 'worktree removal failed read-back')
      }
      const closed = { ...closing, state: 'CLOSED', result: 'closed', updatedAt: new Date().toISOString() }
      writeState(repository, { ...state, allocations: { ...state.allocations, [id]: closed } })
      return closed
    } catch (error) {
      throw error
    }
  })
}

export function reconcileAllocations({ cwd, repair = false } = {}) {
  const repository = discoverRepository(cwd)
  const inspect = () => {
    const state = readState(repository)
    const records = primaryFacts(repository).records
    const actions = []
    const nextAllocations = { ...state.allocations }
    const nextHistory = { ...state.history }
    const { primary } = primaryFacts(repository)
    if (primary.branch !== integrationBranch(repository)) actions.push({ id: 'primary', from: primary.branch ?? 'DETACHED', to: 'UNKNOWN', unsafe: true })
    try { requireClean(repository.primaryRoot, 'PRIMARY_DIRTY') } catch (error) { actions.push({ id: 'primary', from: 'DIRTY', to: 'UNKNOWN', unsafe: true, code: error.code ?? 'PRIMARY_DIRTY' }) }
    if (Object.values(state.allocations).filter(activeAllocation).length > 2) actions.push({ id: 'capacity', from: 'OVER_CAPACITY', to: 'UNKNOWN', unsafe: true })
    if (existsSync(repository.worktreeRoot)) {
      try { assertRealContainer(repository) } catch (error) { actions.push({ id: '.worktree', from: 'UNMANAGED', to: 'UNKNOWN', unsafe: true, code: error.code ?? 'PATH_ESCAPE' }) }
    }
    for (const allocation of Object.values(state.allocations)) {
      const observed = inspectAllocation(repository, allocation, records)
      if (allocation.state === 'ACTIVE' && observed.failures.length > 0) {
        actions.push({ id: allocation.id, from: allocation.state, to: 'UNKNOWN', unsafe: true })
        nextAllocations[allocation.id] = { ...allocation, state: 'UNKNOWN', result: 'repair-unsafe', updatedAt: new Date().toISOString() }
      } else if (allocation.state === 'CLOSED' && observed.failures.length > 0) {
        actions.push({ id: allocation.id, from: allocation.state, to: 'UNKNOWN', unsafe: true })
        nextAllocations[allocation.id] = { ...allocation, state: 'UNKNOWN', result: 'repair-unsafe', updatedAt: new Date().toISOString() }
      } else if (allocation.state === 'OPENING' && !observed.registered && !observed.pathExists && git(['rev-parse', `refs/heads/${allocation.branch}`], repository.primaryRoot, true) === '') {
        actions.push({ id: allocation.id, from: allocation.state, to: 'ABORTED' })
        nextAllocations[allocation.id] = { ...allocation, state: 'ABORTED', result: 'reconciled-open-not-applied', updatedAt: new Date().toISOString() }
      } else if (allocation.state === 'OPENING' && !observed.registered && !observed.pathExists && git(['rev-parse', `refs/heads/${allocation.branch}`], repository.primaryRoot, true) === allocation.base) {
        actions.push({ id: allocation.id, from: allocation.state, to: 'ABORTED', deleteBranch: allocation.branch, base: allocation.base })
        nextAllocations[allocation.id] = { ...allocation, state: 'ABORTED', result: 'reconciled-empty-branch', updatedAt: new Date().toISOString() }
      } else if (observed.registered && observed.pathExists && observed.failures.length === 0 && observed.observedHead === allocation.base && allocation.state === 'OPENING') {
        actions.push({ id: allocation.id, from: allocation.state, to: 'ACTIVE' })
        nextAllocations[allocation.id] = { ...allocation, state: 'ACTIVE', result: 'reconciled-open', updatedAt: new Date().toISOString() }
      } else if (observed.registered && observed.pathExists && observed.failures.length === 0 && allocation.state === 'CLOSING') {
        actions.push({ id: allocation.id, from: allocation.state, to: 'ACTIVE' })
        nextAllocations[allocation.id] = { ...allocation, state: 'ACTIVE', candidate: null, outcome: null, archiveRef: null, integrationHead: null, result: 'reconciled-close-not-applied', updatedAt: new Date().toISOString() }
      } else if (!observed.registered && !observed.pathExists && allocation.state === 'CLOSING'
        && outcomeStillProven(repository, allocation)) {
        actions.push({ id: allocation.id, from: allocation.state, to: 'CLOSED' })
        nextAllocations[allocation.id] = { ...allocation, state: 'CLOSED', result: 'reconciled-close', updatedAt: new Date().toISOString() }
      } else if (['OPENING', 'CLOSING', 'UNKNOWN'].includes(allocation.state)) {
        actions.push({ id: allocation.id, from: allocation.state, to: 'UNKNOWN', unsafe: true })
        nextAllocations[allocation.id] = { ...allocation, state: 'UNKNOWN', result: 'repair-unsafe', updatedAt: new Date().toISOString() }
      }
    }
    for (const [id, entries] of Object.entries(state.history)) {
      for (let index = 0; index < entries.length; index += 1) {
        const observed = inspectAllocation(repository, entries[index], records, true)
        if (observed.failures.length > 0) {
          actions.push({ id: `${id}/${entries[index].generation}`, from: entries[index].state, to: 'UNKNOWN', unsafe: true })
          const repaired = { ...entries[index], state: 'UNKNOWN', result: 'repair-unsafe', updatedAt: new Date().toISOString() }
          nextHistory[id] = [...(nextHistory[id] ?? entries)]
          nextHistory[id][index] = repaired
        }
      }
    }
    for (const record of records.slice(1)) {
      if (!Object.values(state.allocations).some(allocation => comparable(allocation.path) === comparable(record.path))) {
        actions.push({ id: basename(record.path), from: 'UNMANAGED', to: 'UNKNOWN', unsafe: true })
      }
    }
    if (existsSync(repository.worktreeRoot)) {
      for (const entry of readdirSync(repository.worktreeRoot, { withFileTypes: true })) {
        const path = join(repository.worktreeRoot, entry.name)
        if (!Object.values(state.allocations).some(allocation => comparable(allocation.path) === comparable(path))) {
          actions.push({ id: entry.name, from: 'UNMANAGED', to: 'UNKNOWN', unsafe: true })
        }
      }
    }
    if (repair && actions.length > 0) {
      const safe = actions.every(action => action.unsafe !== true)
      if (!safe) {
        writeState(repository, { ...state, allocations: nextAllocations, history: nextHistory })
        throw new LifecycleError('REPAIR_UNSAFE', 'reconcile classified an ambiguous lifecycle state as UNKNOWN; no Git repair was applied')
      }
      for (const action of actions) if (action.deleteBranch && !gitSucceeds(['update-ref', '-d', `refs/heads/${action.deleteBranch}`, action.base], repository.primaryRoot)) throw new LifecycleError('ALLOCATION_DRIFT', 'empty OPENING branch changed during reconciliation')
      return { actions, state: writeState(repository, { ...state, allocations: nextAllocations, history: nextHistory }) }
    }
    return { actions, state }
  }
  if (repair) {
    requirePrimaryCaller(repository)
    return withAuthorityLock(repository, () => {
      requirePrimaryCaller(repository)
      return inspect()
    })
  }
  return withAuthorityLock(repository, inspect)
}
