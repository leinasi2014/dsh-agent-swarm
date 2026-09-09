import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyReleaseReachability } from './verify-official-baseline.mjs'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))

async function git(args, cwd) {
  const { stdout } = await execFileAsync('git', args, {
    ...(cwd === undefined ? {} : { cwd }),
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  })
  return stdout.trim()
}

// A reference pin is an audited source snapshot. A moving upstream branch
// may advance, but must still contain that snapshot; rewrites fail closed.
export async function verifyReferenceBaseline(pointer, source) {
  const failures = [], notes = []
  const remote = await git(['ls-remote', pointer.repository, `refs/heads/${pointer.branch}`])
  const branchHead = remote.split(/\r?\n/).filter(Boolean).map(line => line.split(/\s+/, 2))
    .find(([, ref]) => ref === `refs/heads/${pointer.branch}`)?.[0]
  if (branchHead === undefined) failures.push(`branch ${pointer.branch} is missing`)
  else if (branchHead !== pointer.commit) {
    const reachable = await verifyReleaseReachability({ repository: pointer.repository, pin: pointer.commit, commit: branchHead })
    if (reachable !== true) failures.push(reachable === false
      ? `branch ${pointer.branch} no longer contains pin ${pointer.commit}`
      : `could not verify pin reachability from ${pointer.branch}`)
    else notes.push(`${pointer.branch} advanced to ${branchHead}; audited pin remains ${pointer.commit}; review upstream changes before adopting new claims`)
  }
  const localHead = await git(['rev-parse', 'HEAD'], source)
  if (localHead !== pointer.commit) failures.push(`checkout is ${localHead}, pin is ${pointer.commit}`)
  const localTree = await git(['rev-parse', 'HEAD^{tree}'], source)
  if (localTree !== pointer.tree) failures.push(`checkout tree is ${localTree}, pin tree is ${pointer.tree}`)
  if (await git(['status', '--porcelain'], source) !== '') failures.push('checkout is dirty')
  return { failures, notes }
}

async function main() {
  const failures = []
  for (const name of ['dsh-agent-teams', 'jiuwenswarm']) {
    try {
      const pointer = JSON.parse(await readFile(resolve(root, 'ref', name, 'SOURCE_POINTER.json'), 'utf8'))
      const result = await verifyReferenceBaseline(pointer, resolve(root, 'ref', name, pointer.local_checkout))
      failures.push(...result.failures.map(failure => `${name}: ${failure}`))
      for (const note of result.notes) console.log(`${name}: ${note}`)
    } catch (error) {
      failures.push(`${name}: ${String(error)}`)
    }
  }
  if (failures.length > 0) {
    console.error('Reference baseline verification failed:')
    for (const failure of failures) console.error(`- ${failure}`)
    console.error('Review upstream changes before updating pins, architecture, fusion claims, or milestones.')
    process.exitCode = 1
  } else console.log('Reference pin reachability, trees, and clean local checkouts: PASS')
}

const invokedAs = process.argv[1] === undefined ? undefined : resolve(process.argv[1])
if (invokedAs?.toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) await main()
