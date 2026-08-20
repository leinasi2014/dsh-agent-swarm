import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))
const failures = []

async function git(args, cwd) {
  const { stdout } = await execFileAsync('git', args, {
    ...(cwd === undefined ? {} : { cwd }),
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  })
  return stdout.trim()
}

for (const name of ['dsh-agent-teams', 'jiuwenswarm']) {
  try {
    const pointerPath = resolve(root, 'ref', name, 'SOURCE_POINTER.json')
    const pointer = JSON.parse(await readFile(pointerPath, 'utf8'))
    const source = resolve(root, 'ref', name, pointer.local_checkout)
    const remote = await git(['ls-remote', pointer.repository, 'HEAD', `refs/heads/${pointer.branch}`])
    const refs = new Map(remote.split(/\r?\n/).filter(Boolean).map(line => {
      const [sha, ref] = line.split(/\s+/, 2)
      return [ref, sha]
    }))
    for (const ref of ['HEAD', `refs/heads/${pointer.branch}`]) {
      if (refs.get(ref) !== pointer.commit) {
        failures.push(`${name} ${ref} is ${refs.get(ref) ?? 'missing'}, pin is ${pointer.commit}`)
      }
    }
    const localHead = await git(['rev-parse', 'HEAD'], source)
    if (localHead !== pointer.commit) failures.push(`${name} checkout is ${localHead}, pin is ${pointer.commit}`)
    const dirty = await git(['status', '--porcelain'], source)
    if (dirty !== '') failures.push(`${name} checkout is dirty`)
  } catch (error) {
    failures.push(`${name}: ${String(error)}`)
  }
}

if (failures.length > 0) {
  console.error('Reference baseline verification failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  console.error('Review upstream changes before updating pins, architecture, fusion claims, or milestones.')
  process.exitCode = 1
} else {
  console.log('Reference remotes, pins, and clean local checkouts: PASS')
}
