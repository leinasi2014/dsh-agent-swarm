import { execFileSync } from 'node:child_process'

function succeeds(args, cwd, input) {
  try {
    execFileSync('git', args, { cwd, input, stdio: ['pipe', 'ignore', 'ignore'], timeout: 30_000, windowsHide: true })
    return true
  } catch {
    return false
  }
}

function output(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000, windowsHide: true })
  } catch {
    return undefined
  }
}

export function integrationProof(repository, base, candidate) {
  const head = output(['rev-parse', 'HEAD'], repository.primaryRoot)?.trim()
  if (!head) return null
  if (succeeds(['merge-base', '--is-ancestor', candidate, head], repository.primaryRoot)) return head
  const patch = output(['diff', '--binary', `${base}..${candidate}`], repository.primaryRoot)
  if (patch === undefined || !succeeds(['apply', '--reverse', '--check', '--whitespace=nowarn', '-'], repository.primaryRoot, patch)) return null
  return head
}

export function outcomeStillProven(repository, allocation) {
  if (allocation.outcome === 'integrated') {
    return allocation.integrationHead !== null
      && succeeds(['merge-base', '--is-ancestor', allocation.integrationHead, 'HEAD'], repository.primaryRoot)
  }
  return allocation.outcome === 'archived'
    && allocation.archiveRef !== null
    && allocation.archiveRef.startsWith('refs/archive/')
    && succeeds(['check-ref-format', allocation.archiveRef], repository.primaryRoot)
    && succeeds(['show-ref', '--verify', '--quiet', allocation.archiveRef], repository.primaryRoot)
    && output(['rev-parse', `${allocation.archiveRef}^{commit}`], repository.primaryRoot)?.trim() === allocation.candidate
}
