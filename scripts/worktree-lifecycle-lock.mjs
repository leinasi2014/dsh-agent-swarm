import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'

function sleep(milliseconds) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds) }

function acquire(path, timeoutMilliseconds, LifecycleError, guardPath) {
  const deadline = Date.now() + timeoutMilliseconds
  while (true) {
    if (guardPath && existsSync(guardPath)) {
      if (Date.now() >= deadline) throw new LifecycleError('LOCK_BUSY', 'isolation authority recovery is in progress')
      sleep(25)
      continue
    }
    try {
      const nonce = randomUUID()
      const descriptor = openSync(path, 'wx')
      try {
        writeFileSync(descriptor, `${JSON.stringify({ schemaVersion: 1, hostname: hostname(), pid: process.pid, startedAt: new Date().toISOString(), nonce })}\n`, 'utf8')
        fsyncSync(descriptor)
      } finally { closeSync(descriptor) }
      return nonce
    } catch (error) {
      if (!existsSync(path)) throw error
      if (Date.now() >= deadline) throw new LifecycleError('LOCK_BUSY', 'isolation authority lock is busy; it was not broken automatically')
      sleep(25)
    }
  }
}

export function withAuthorityLock(repository, callback, LifecycleError, timeoutMilliseconds = 2_000) {
  const guardPath = `${repository.lockPath}.recovery`
  const nonce = acquire(repository.lockPath, timeoutMilliseconds, LifecycleError, guardPath)
  try { return callback() } finally {
    try {
      if (JSON.parse(readFileSync(repository.lockPath, 'utf8'))?.nonce === nonce) unlinkSync(repository.lockPath)
    } catch { /* a former holder never removes an unreadable or replaced lock */ }
  }
}

function processIsAlive(pid, LifecycleError) {
  try { process.kill(pid, 0); return true } catch (error) {
    if (error.code === 'ESRCH') return false
    throw new LifecycleError('LOCK_OWNER_UNKNOWN', 'lock owner liveness cannot be proven')
  }
}

export function recoverDeadLock(repository, LifecycleError) {
  const guardPath = `${repository.lockPath}.recovery`
  const guardNonce = acquire(guardPath, 2_000, LifecycleError)
  try {
    if (!existsSync(repository.lockPath)) return { recovered: false, reason: 'no-lock' }
    let owner
    try { owner = JSON.parse(readFileSync(repository.lockPath, 'utf8')) } catch { throw new LifecycleError('LOCK_OWNER_UNKNOWN', 'lock has no valid owner identity and was not broken') }
    if (owner?.schemaVersion !== 1 || owner.hostname !== hostname() || !Number.isInteger(owner.pid) || owner.pid <= 0 || typeof owner.nonce !== 'string') throw new LifecycleError('LOCK_OWNER_UNKNOWN', 'lock owner identity is not locally provable and was not broken')
    if (processIsAlive(owner.pid, LifecycleError)) throw new LifecycleError('LOCK_BUSY', 'lock owner process is still alive')
    const tombstone = `${repository.lockPath}.recovered-${owner.nonce}-${randomUUID()}`
    try { renameSync(repository.lockPath, tombstone) } catch { throw new LifecycleError('LOCK_BUSY', 'lock changed during recovery; it was not broken') }
    unlinkSync(tombstone)
    return { recovered: true, owner: { hostname: owner.hostname, pid: owner.pid, startedAt: owner.startedAt } }
  } finally {
    try { if (JSON.parse(readFileSync(guardPath, 'utf8'))?.nonce === guardNonce) unlinkSync(guardPath) } catch { /* never remove another recovery guard */ }
  }
}
