import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { verifyReferenceBaseline } from './verify-reference-baselines.mjs'

// Exercise real fetch/ancestry against a disposable upstream; no network stub.
const fixture = await mkdtemp(join(tmpdir(), 'dsh-reference-gate-'))
const source = join(fixture, 'source'), remote = join(fixture, 'remote.git')
const git = (args, cwd = source) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true,
  env: { ...process.env, GIT_AUTHOR_NAME: 'Reference fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Reference fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' }, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
try {
  await mkdir(source)
  git(['init', '--quiet'])
  git(['init', '--bare', '--quiet', '--initial-branch=unused', remote])
  await writeFile(join(source, 'reference.txt'), 'audited snapshot\n')
  git(['add', 'reference.txt']); git(['commit', '--quiet', '-m', 'pinned source'])
  const commit = git(['rev-parse', 'HEAD']), tree = git(['rev-parse', 'HEAD^{tree}'])
  const pointer = { repository: remote, branch: 'main', commit, tree }
  const publish = sha => git(['push', '--quiet', '--force', remote, `${sha}:refs/heads/main`])
  publish(commit)
  assert.deepEqual((await verifyReferenceBaseline(pointer, source)).failures, [])
  const advanced = git(['commit-tree', tree, '-p', commit, '-m', 'upstream advance'])
  publish(advanced)
  const result = await verifyReferenceBaseline(pointer, source)
  assert.deepEqual(result.failures, []); assert.equal(result.notes.length, 1)
  assert.match((await verifyReferenceBaseline({ ...pointer, tree: '0'.repeat(40) }, source)).failures.join(), /tree/)
  await writeFile(join(source, 'untracked.txt'), 'local work\n')
  assert.match((await verifyReferenceBaseline(pointer, source)).failures.join(), /dirty/)
  await rm(join(source, 'untracked.txt'))
  const unrelated = git(['commit-tree', tree, '-m', 'force-pushed unrelated history'])
  publish(unrelated)
  assert.match((await verifyReferenceBaseline(pointer, source)).failures.join(), /no longer contains pin/)
  git(['push', '--quiet', remote, ':refs/heads/main'])
  assert.match((await verifyReferenceBaseline(pointer, source)).failures.join(), /missing/)
  console.log('Reference gate: real Git pin/advance PASS; wrong tree, dirty checkout, force-push and deleted branch rejected')
} finally {
  const location = relative(resolve(tmpdir()), resolve(fixture))
  assert(location.startsWith('dsh-reference-gate-') && !location.includes('..'))
  await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
