// M3-3 freeze lane (issue #102, design §1.2 option B): build the frozen
// candidate artifact on the PM side, NEVER inside a worker execution root.
//
// A clean detached worktree of the exact commit (CONTRIBUTING §2a practice)
// is checked out under a fresh temp directory, built with the recorded
// command sequence, packed with `pnpm pack`, and the resulting tarball is
// COPIED (never linked) into candidates/<candidateId>/ together with its
// manifest. The integrity anchor is the git commit/tree SHA (reproducible);
// the tarball digest is the artifact identity (built once, then immutable
// along the whole evidence chain — manifest → verdict → ledger → lkg/g<N>).
//
// Refusal conditions (fail-loud): unknown commit, dirty checkout after
// checkout, failed install/build/pack, missing digest.
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { controlRootLayout, sha256File, writeJsonFile } from './lib.mjs'
import { git, run, withDetachedWorktree } from './runner.mjs'

/** Lanes of the non-degradable acceptance floor (docs §2.3 A1 selection). */
export const FLOOR_LANES = ['typecheck', 'typecheck:test', 'test', 'verify:scenarios', 'build', 'verify:artifact']
/** The full first-drill superset (adds the repository hygiene lanes). */
export const FULL_LANES = ['lint', 'verify:duplication', 'verify:exports', ...FLOOR_LANES]

function parseArgs(argv) {
  const args = { buildLanes: null }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const next = () => {
      index += 1
      if (index >= argv.length) throw new Error(`missing value for ${argument}`)
      return argv[index]
    }
    if (argument === '--repo') args.repo = resolve(next())
    else if (argument === '--commit') args.commit = next()
    else if (argument === '--dogfood-root') args.dogfoodRoot = resolve(next())
    else if (argument === '--candidate-id') args.candidateId = next()
    else if (argument === '--note') args.note = next()
    else throw new Error(`unknown argument ${argument}`)
  }
  for (const required of ['repo', 'commit', 'dogfoodRoot']) {
    if (args[required] === undefined) throw new Error(`--${required.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)} is required`)
  }
  return args
}

async function resolveCommit(repo, commit) {
  const sha = await git(repo, ['rev-parse', `${commit}^{commit}`])
  if (sha.code !== 0) throw new Error(`commit ${commit} not found in ${repo}: ${sha.stderr || sha.stdout}`)
  const tree = await git(repo, ['rev-parse', `${sha.stdout.trim()}^{tree}`])
  if (tree.code !== 0) throw new Error(`tree resolution failed: ${tree.stderr}`)
  return { commitSha: sha.stdout.trim(), treeSha: tree.stdout.trim() }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const layout = controlRootLayout(args.dogfoodRoot)
  const { commitSha, treeSha } = await resolveCommit(args.repo, args.commit)
  const toolRepo = resolve(import.meta.dirname, '..', '..')
  const toolHead = await git(toolRepo, ['rev-parse', 'HEAD'])
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
  const candidateId = args.candidateId ?? `${stamp}-${commitSha.slice(0, 8)}`
  const candidateDir = join(layout.candidatesDir, candidateId)
  const manifestExisting = await stat(candidateDir).catch(() => undefined)
  if (manifestExisting !== undefined) throw new Error(`candidate directory already exists: ${candidateDir}`)
  await mkdir(candidateDir, { recursive: true })
  const buildCommand = ['pnpm install --frozen-lockfile', 'pnpm build', 'pnpm pack']
  const logs = {}
  let packedTarball
  let frozenPkg
  await withDetachedWorktree(args.repo, commitSha, async worktree => {
    const clean = await git(worktree, ['status', '--porcelain'])
    if (clean.code !== 0 || clean.stdout.trim() !== '') {
      throw new Error(`freeze worktree is not clean after checkout: ${clean.stdout || clean.stderr}`)
    }
    logs['worktree-status.txt'] = clean.stdout === '' ? 'clean\n' : clean.stdout
    frozenPkg = JSON.parse(await readFile(join(worktree, 'package.json'), 'utf8'))
    const install = await run('pnpm', ['install', '--frozen-lockfile'], { cwd: worktree })
    logs['install.log'] = install.stdout + install.stderr
    if (install.code !== 0) throw new Error(`pnpm install failed in the freeze worktree (exit ${install.code}) — see ${candidateDir}/install.log`)
    const build = await run('pnpm', ['build'], { cwd: worktree })
    logs['build.log'] = build.stdout + build.stderr
    if (build.code !== 0) throw new Error(`pnpm build failed in the freeze worktree (exit ${build.code}) — see ${candidateDir}/build.log`)
    const pack = await run('pnpm', ['pack', '--pack-destination', worktree], { cwd: worktree })
    logs['pack.log'] = pack.stdout + pack.stderr
    if (pack.code !== 0) throw new Error(`pnpm pack failed in the freeze worktree (exit ${pack.code})`)
    const packed = /dsh-agent-swarm-[^\s]+\.tgz/.exec(pack.stdout)
    if (packed === null) throw new Error(`pnpm pack produced no dsh-agent-swarm tarball: ${pack.stdout}`)
    packedTarball = join(worktree, packed[0])
  }, 'agent-swarm-freeze')
  const tarballPath = join(candidateDir, 'dsh-agent-swarm.tgz')
  await copyFile(packedTarball, tarballPath)
  const tarballSha256 = await sha256File(tarballPath)
  const tarballBytes = (await stat(tarballPath)).size
  const manifest = {
    schemaVersion: 1,
    candidateId,
    gitCommit: commitSha,
    gitTree: treeSha,
    tarballSha256,
    tarballBytes,
    builtBy: `freeze-lane@stable-checkout-${(toolHead.stdout.trim() || 'unknown').slice(0, 8)}`,
    builtAt: new Date().toISOString(),
    buildCommand,
    packageVersion: frozenPkg.version,
    peerPins: frozenPkg.peerDependencies ?? {},
    acceptanceFloor: FLOOR_LANES,
    ...(args.note !== undefined ? { note: args.note } : {}),
  }
  await writeJsonFile(join(candidateDir, 'manifest.json'), manifest)
  for (const [name, content] of Object.entries(logs)) {
    await writeFile(join(candidateDir, name), content, 'utf8')
  }
  console.log(JSON.stringify({ frozen: true, candidateId, gitCommit: commitSha, gitTree: treeSha, tarballSha256, tarballBytes, candidateDir, cleanWorktree: true }, null, 2))
}

main().catch(error => {
  console.error(`freeze failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
