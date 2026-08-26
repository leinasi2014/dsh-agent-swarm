import { execFileSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'

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

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
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
  if (state?.schemaVersion !== 1 || state?.authorityEpoch !== 3 || !Number.isInteger(state?.revision) || state.revision < 0 || typeof state?.allocations !== 'object' || state.allocations === null || Array.isArray(state.allocations)) {
    throw new LifecycleError('AUTHORITY_CORRUPT', 'isolation authority state has an unsupported schema')
  }
  for (const [id, allocation] of Object.entries(state.allocations)) {
    const valid = allocation?.id === id
      && /^[a-z0-9][a-z0-9._-]*$/u.test(id)
      && Number.isInteger(allocation.generation) && allocation.generation > 0
      && ['OPENING', 'ACTIVE', 'CLOSING', 'CLOSED', 'UNKNOWN'].includes(allocation.state)
      && typeof allocation.owner === 'string' && allocation.owner !== ''
      && typeof allocation.base === 'string' && /^[0-9a-f]{40}$/u.test(allocation.base)
      && typeof allocation.branch === 'string' && allocation.branch !== ''
      && typeof allocation.path === 'string' && isAbsolute(allocation.path)
      && (allocation.candidate === null || (typeof allocation.candidate === 'string' && /^[0-9a-f]{40}$/u.test(allocation.candidate)))
      && (allocation.outcome === null || ['integrated', 'archived'].includes(allocation.outcome))
      && typeof allocation.result === 'string'
      && typeof allocation.updatedAt === 'string'
    if (!valid) throw new LifecycleError('AUTHORITY_CORRUPT', `allocation ${id} has an unsupported schema`)
  }
  return state
}

function writeState(repository, state) {
  mkdirSync(repository.authorityRoot, { recursive: true })
  const next = { ...state, revision: state.revision + 1 }
  const temporary = join(repository.authorityRoot, `.state-${process.pid}-${randomUUID()}.tmp`)
  const descriptor = openSync(temporary, 'wx')
  try {
    writeFileSync(descriptor, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  } finally {
    closeSync(descriptor)
  }
  renameSync(temporary, repository.statePath)
  return next
}

export function withAuthorityLock(repository, callback, timeoutMilliseconds = 2_000) {
  mkdirSync(repository.authorityRoot, { recursive: true })
  const deadline = Date.now() + timeoutMilliseconds
  while (true) {
    try {
      mkdirSync(repository.lockPath)
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (Date.now() >= deadline) throw new LifecycleError('LOCK_BUSY', 'isolation authority lock is busy; it was not broken automatically')
      sleep(25)
    }
  }
  try {
    return callback()
  } finally {
    rmSync(repository.lockPath, { recursive: true, force: true })
  }
}

function assertSlug(id) {
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(id)) throw new LifecycleError('INVALID_ID', 'allocation id must be a stable lowercase slug')
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

function allocationPath(repository, id) {
  const path = resolve(repository.worktreeRoot, id)
  if (!directChild(repository.worktreeRoot, path)) throw new LifecycleError('PATH_ESCAPE', 'allocation path escapes .worktree')
  return path
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
  return withAuthorityLock(repository, () => {
    const records = ensurePrimaryReady(repository)
    let state = readState(repository)
    if (Object.values(state.allocations).some(allocation => ['OPENING', 'CLOSING', 'UNKNOWN'].includes(allocation.state))) {
      throw new LifecycleError('RESULT_UNKNOWN', 'an incomplete or ambiguous allocation freezes new writer allocation until reconciliation')
    }
    if (Object.values(state.allocations).filter(allocation => activeAllocation(allocation)).length >= 2) {
      throw new LifecycleError('CAPACITY_EXCEEDED', 'the managed writer capacity is two active allocations')
    }
    for (const record of records.slice(1)) {
      const allocation = Object.values(state.allocations).find(item => comparable(item.path) === comparable(record.path))
      if (allocation === undefined || inspectAllocation(repository, allocation, records).failures.length > 0) {
        throw new LifecycleError('RAW_WORKTREE_DETECTED', 'an unmanaged or drifted worktree blocks new allocation')
      }
    }
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
      result: 'intent-recorded',
      updatedAt: new Date().toISOString(),
    }
    state = writeState(repository, { ...state, allocations: { ...state.allocations, [id]: allocation } })
    try {
      mkdirSync(repository.worktreeRoot, { recursive: true })
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

function inspectAllocation(repository, allocation, records) {
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
  } else if (pathExists || record !== undefined) {
    failures.push('ALLOCATION_DRIFT')
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
  for (const allocation of allocations) {
    if (allocation.state === 'UNKNOWN') failures.push('RESULT_UNKNOWN')
  }
  for (const record of records.slice(1)) {
    if (!allocations.some(allocation => comparable(allocation.path) === comparable(record.path))) failures.push('RAW_WORKTREE_DETECTED')
  }
  if (existsSync(repository.worktreeRoot)) {
    for (const entry of readdirSync(repository.worktreeRoot, { withFileTypes: true })) {
      const path = join(repository.worktreeRoot, entry.name)
      if (!allocations.some(allocation => comparable(allocation.path) === comparable(path))) failures.push('RAW_WORKTREE_DETECTED')
    }
  }
  for (const allocation of allocations) failures.push(...allocation.failures)
  const report = {
    schemaVersion: 1,
    authorityEpoch: state.authorityEpoch,
    revision: state.revision,
    primary: { path: repository.primaryRoot, branch: primary.branch ?? null, head: primary.head },
    allocations,
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

function patchEquivalent(repository, integrationHead, candidate) {
  if (candidate === integrationHead) return true
  const cherry = git(['cherry', integrationHead, candidate], repository.primaryRoot, true)
  return cherry !== '' && cherry.split(/\r?\n/u).every(line => line.startsWith('- '))
}

export function closeAllocation({ cwd, id, generation, owner, outcome, archiveRef }) {
  assertSlug(id)
  const repository = discoverRepository(cwd)
  return withAuthorityLock(repository, () => {
    const records = ensurePrimaryReady(repository)
    let state = readState(repository, { allowMissing: false })
    const allocation = state.allocations[id]
    if (allocation === undefined || allocation.state !== 'ACTIVE') throw new LifecycleError('ALLOCATION_NOT_ACTIVE', `allocation ${id} is not ACTIVE`)
    if (Number(generation) !== allocation.generation) throw new LifecycleError('STALE_GENERATION', 'allocation generation does not match')
    if (typeof owner !== 'string' || owner === '' || owner !== allocation.owner) throw new LifecycleError('OWNER_MISMATCH', 'allocation owner does not match')
    const observed = inspectAllocation(repository, allocation, records)
    if (observed.failures.length > 0) throw new LifecycleError(observed.failures[0], 'allocation identity does not match the authority ledger')
    requireClean(allocation.path)
    const candidate = git(['rev-parse', 'HEAD'], allocation.path)
    const integrationHead = git(['rev-parse', 'HEAD'], repository.primaryRoot)
    if (outcome === 'integrated') {
      const ancestor = gitSucceeds(['merge-base', '--is-ancestor', candidate, integrationHead], repository.primaryRoot)
      if (!ancestor && !patchEquivalent(repository, integrationHead, candidate)) throw new LifecycleError('OUTCOME_UNPROVEN', 'candidate is neither integrated nor patch-equivalent')
    } else if (outcome === 'archived') {
      if (!archiveRef) throw new LifecycleError('OUTCOME_UNPROVEN', 'archived close requires --archive-ref')
      if (!archiveRef.startsWith('refs/archive/') || !gitSucceeds(['check-ref-format', archiveRef], repository.primaryRoot) || !gitSucceeds(['show-ref', '--verify', '--quiet', archiveRef], repository.primaryRoot)) {
        throw new LifecycleError('OUTCOME_UNPROVEN', 'archive proof must be an existing durable refs/archive/* ref')
      }
      const archived = git(['rev-parse', `${archiveRef}^{commit}`], repository.primaryRoot, true)
      if (archived !== candidate) throw new LifecycleError('OUTCOME_UNPROVEN', 'archive ref does not preserve the candidate')
    } else {
      throw new LifecycleError('OUTCOME_UNPROVEN', 'close outcome must be integrated or archived')
    }
    const closing = { ...allocation, state: 'CLOSING', candidate, outcome, result: 'close-intent-recorded', updatedAt: new Date().toISOString() }
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
    for (const allocation of Object.values(state.allocations)) {
      if (!['OPENING', 'CLOSING', 'UNKNOWN'].includes(allocation.state)) continue
      const observed = inspectAllocation(repository, allocation, records)
      if (observed.registered && observed.pathExists && observed.failures.length === 0 && observed.observedHead === allocation.base && allocation.state === 'OPENING') {
        actions.push({ id: allocation.id, from: allocation.state, to: 'ACTIVE' })
        nextAllocations[allocation.id] = { ...allocation, state: 'ACTIVE', result: 'reconciled-open', updatedAt: new Date().toISOString() }
      } else if (observed.registered && observed.pathExists && observed.failures.length === 0 && allocation.state === 'CLOSING') {
        actions.push({ id: allocation.id, from: allocation.state, to: 'ACTIVE' })
        nextAllocations[allocation.id] = { ...allocation, state: 'ACTIVE', candidate: null, outcome: null, result: 'reconciled-close-not-applied', updatedAt: new Date().toISOString() }
      } else if (!observed.registered && !observed.pathExists && allocation.state === 'CLOSING') {
        actions.push({ id: allocation.id, from: allocation.state, to: 'CLOSED' })
        nextAllocations[allocation.id] = { ...allocation, state: 'CLOSED', result: 'reconciled-close', updatedAt: new Date().toISOString() }
      } else {
        actions.push({ id: allocation.id, from: allocation.state, to: 'UNKNOWN', unsafe: true })
        nextAllocations[allocation.id] = { ...allocation, state: 'UNKNOWN', result: 'repair-unsafe', updatedAt: new Date().toISOString() }
      }
    }
    if (repair && actions.length > 0) {
      const safe = actions.every(action => action.unsafe !== true)
      if (!safe) {
        writeState(repository, { ...state, allocations: nextAllocations })
        throw new LifecycleError('REPAIR_UNSAFE', 'reconcile classified an ambiguous lifecycle state as UNKNOWN; no Git repair was applied')
      }
      return { actions, state: writeState(repository, { ...state, allocations: nextAllocations }) }
    }
    return { actions, state }
  }
  return withAuthorityLock(repository, inspect)
}
