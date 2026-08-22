import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const verifier = resolve('scripts/verify-worktree-layout.mjs')
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

  const allowed = join(repo, '.worktree', 'allowed')
  git(['worktree', 'add', allowed, '-b', 'test/allowed'])
  verify(true, 'allowed in-repository task worktree')
  git(['-C', allowed, 'checkout', '--detach'])
  verify(false, 'detached development worktree')
  git(['worktree', 'remove', allowed])

  const forbidden = join(dirname(repo), `${basename(repo)}-wt-forbidden`)
  git(['worktree', 'add', forbidden, '-b', 'test/forbidden'])
  verify(false, 'legacy sibling worktree')
  git(['worktree', 'remove', forbidden])

  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n')
  verify(false, 'missing worktree ignore rule')
  console.log('Worktree governance negative tests: PASS')
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true })
}
