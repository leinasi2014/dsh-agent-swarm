import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const verifier = resolve('scripts/verify-worktree-layout.mjs')
const statusVerifier = resolve('scripts/verify-isolation-status.mjs')
const fixtureRoot = mkdtempSync(join(tmpdir(), 'dsh-worktree-gate-'))
const repo = join(fixtureRoot, 'fixture-repo')

function git(args, cwd = repo) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function verify(expectedSuccess, label) {
  const result = spawnSync(process.execPath, [verifier], { cwd: repo, encoding: 'utf8' })
  if ((result.status === 0) !== expectedSuccess) {
    throw new Error(`${label}: unexpected verifier result\n${result.stdout}\n${result.stderr}`)
  }
}

function verifyStatus(expectedSuccess, label) {
  const result = spawnSync(process.execPath, [statusVerifier], { cwd: repo, encoding: 'utf8' })
  if ((result.status === 0) !== expectedSuccess) {
    throw new Error(`${label}: unexpected isolation status result\n${result.stdout}\n${result.stderr}`)
  }
}

try {
  mkdirSync(repo)
  git(['init', '-b', 'main'])
  git(['config', 'user.email', 'gate-test@example.invalid'])
  git(['config', 'user.name', 'Worktree Gate Test'])
  writeFileSync(join(repo, '.gitignore'), '/.worktree/\n')
  writeFileSync(join(repo, 'README.md'), '# Gate fixture\n')
  git(['add', '.'])
  git(['commit', '-m', 'test: establish governed fixture'])
  verify(true, 'main-only governed repository')
  verifyStatus(true, 'main-only managed-isolation baseline')

  const allowed = join(repo, '.worktree', 'allowed')
  git(['worktree', 'add', allowed, '-b', 'test/allowed'])
  verify(true, 'allowed in-repository task worktree')
  verifyStatus(false, 'managed status rejects an unregistered worktree')
  git(['-C', allowed, 'checkout', '--detach'])
  verify(false, 'detached development worktree')
  git(['worktree', 'remove', allowed])

  const completed = join(repo, '.worktree', 'completed')
  git(['worktree', 'add', completed, '-b', 'test/completed'])
  writeFileSync(join(completed, 'completed.txt'), 'completed candidate\n')
  git(['add', 'completed.txt'], completed)
  git(['commit', '-m', 'test: complete candidate'], completed)
  const completedHead = git(['rev-parse', 'HEAD'], completed)
  writeFileSync(join(repo, 'main-drift.txt'), 'independent main change\n')
  git(['add', 'main-drift.txt'])
  git(['commit', '-m', 'test: advance integration branch'])
  git(['cherry-pick', completedHead])
  verify(false, 'integrated but unreclaimed worktree')
  git(['worktree', 'remove', completed])

  const forbidden = join(dirname(repo), `${basename(repo)}-wt-forbidden`)
  git(['worktree', 'add', forbidden, '-b', 'test/forbidden'])
  verify(false, 'legacy sibling worktree')
  git(['worktree', 'remove', forbidden])

  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n')
  verify(false, 'missing worktree ignore rule')
  git(['checkout', '--detach'])
  verifyStatus(false, 'managed status rejects a detached primary checkout')
  console.log('Worktree governance and isolation-status negative tests: PASS')
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true })
}
