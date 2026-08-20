/**
 * Double-green merge guard (P0, 2026-08-20 retrospective).
 *
 * Private repositories on the free tier cannot enforce required status
 * checks, and twice that day a PR was merged while a run was failed/pending
 * (PR #11 exposed a real race on main). This guard makes the discipline a
 * mechanism: it polls `gh pr checks` until every check is terminal, requires
 * zero failures and at least one pass, and only then rebase-merges with
 * branch deletion. Anything else exits non-zero without merging.
 *
 * Usage: node scripts/merge-guard.mjs <pr-number>
 */
import { execFileSync } from 'node:child_process'

const pr = process.argv[2]
if (!pr || !/^\d+$/.test(pr)) {
  console.error('usage: node scripts/merge-guard.mjs <pr-number>')
  process.exit(1)
}

const POLL_MS = 20_000
const MAX_POLLS = 90 // ~30 minutes

function checks() {
  const stdout = execFileSync('gh', ['pr', 'checks', pr, '--json', 'name,state'], { encoding: 'utf8' })
  return JSON.parse(stdout)
}

function summarize(list) {
  return list.map(check => `${check.name}=${check.state}`).join(', ')
}

for (let poll = 0; poll < MAX_POLLS; poll += 1) {
  const list = checks()
  if (list.length === 0) {
    console.error(`merge-guard: PR #${pr} reports no checks at all — refusing to merge`)
    process.exit(1)
  }
  const pending = list.filter(check => check.state === 'pending')
  const failed = list.filter(check => check.state === 'fail' || check.state === 'cancel')
  const passed = list.filter(check => check.state === 'pass')
  console.log(`merge-guard: ${summarize(list)}`)
  if (pending.length === 0) {
    if (failed.length > 0 || passed.length === 0) {
      console.error(`merge-guard: PR #${pr} is not double-green (${passed.length} pass, ${failed.length} failed) — refusing to merge`)
      process.exit(1)
    }
    console.log(`merge-guard: PR #${pr} is fully green (${passed.length} checks) — rebase-merging`)
    execFileSync('gh', ['pr', 'merge', pr, '--rebase', '--delete-branch'], { stdio: 'inherit' })
    process.exit(0)
  }
  if (failed.length > 0) {
    console.error(`merge-guard: PR #${pr} already has failures (${summarize(failed)}) — refusing to merge`)
    process.exit(1)
  }
  await new Promise(resolve => setTimeout(resolve, POLL_MS))
}

console.error(`merge-guard: PR #${pr} checks did not settle within ${MAX_POLLS * POLL_MS / 60_000} minutes — refusing to merge`)
process.exit(1)
