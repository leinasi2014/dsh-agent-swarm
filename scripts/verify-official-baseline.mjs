import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))
const baseline = JSON.parse(await readFile(resolve(root, 'docs/OFFICIAL_BASELINE.json'), 'utf8'))
const checkout = resolve(process.env.DSH_OFFICIAL_CHECKOUT ?? resolve(root, '../../framework/deepseek-harness'))
const failures = []

async function git(args, cwd) {
  const { stdout } = await execFileAsync('git', args, {
    ...(cwd === undefined ? {} : { cwd }),
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  })
  return stdout.trim()
}

try {
  const remote = await git(['ls-remote', baseline.repository, 'HEAD', `refs/heads/${baseline.branch}`])
  const refs = new Map(remote.split(/\r?\n/).filter(Boolean).map(line => {
    const [sha, ref] = line.split(/\s+/, 2)
    return [ref, sha]
  }))
  for (const ref of ['HEAD', `refs/heads/${baseline.branch}`]) {
    if (refs.get(ref) !== baseline.commit) {
      failures.push(`official ${ref} is ${refs.get(ref) ?? 'missing'}, baseline is ${baseline.commit}`)
    }
  }
} catch (error) {
  failures.push(`cannot query official remote: ${String(error)}`)
}

try {
  const localHead = await git(['rev-parse', 'HEAD'], checkout)
  if (localHead !== baseline.commit) failures.push(`official checkout HEAD is ${localHead}, baseline is ${baseline.commit}`)
  const dirty = await git(['status', '--porcelain'], checkout)
  if (dirty !== '') failures.push(`official checkout is dirty: ${checkout}`)

  for (const evidenceFile of baseline.evidenceFiles ?? []) {
    try {
      await readFile(resolve(checkout, evidenceFile), 'utf8')
    } catch {
      failures.push(`official evidence file is not materialized in the checkout: ${evidenceFile}`)
    }
  }

  for (const expected of baseline.packages) {
    const raw = await git(['show', `${baseline.commit}:${expected.path}/package.json`], checkout)
    const manifest = JSON.parse(raw)
    if (manifest.name !== expected.name) {
      failures.push(`${expected.path}: expected ${expected.name}, found ${manifest.name ?? 'unnamed'}`)
    }
    if (expected.visibility === 'private') {
      if (manifest.private !== true) failures.push(`${expected.name}: expected private package`)
      if (manifest.publishConfig !== undefined) failures.push(`${expected.name}: private package must not publish`)
    } else if (manifest.private === true) {
      failures.push(`${expected.name}: expected published/public package`)
    }
  }
} catch (error) {
  failures.push(`cannot verify official checkout ${dirname(checkout)}: ${String(error)}`)
}

if (failures.length > 0) {
  console.error('Official-first baseline verification failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  console.error('Review the official diff before updating docs/OFFICIAL_BASELINE.json and architecture/milestones.')
  process.exitCode = 1
} else {
  console.log(`Official DSH ${baseline.release} baseline ${baseline.commit}: remote, checkout evidence, and package visibility PASS`)
}
