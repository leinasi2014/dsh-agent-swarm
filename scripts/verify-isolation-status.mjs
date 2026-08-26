import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

const root = realpathSync(resolve(execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: process.cwd(),
  encoding: 'utf8',
  timeout: 30_000,
  windowsHide: true,
}).trim()))
const output = execFileSync('git', ['worktree', 'list', '--porcelain'], {
  cwd: root,
  encoding: 'utf8',
  timeout: 30_000,
  windowsHide: true,
})
const records = output.trim().split(/\r?\n\r?\n/u).filter(Boolean)
const failures = []

function comparable(path) {
  const normalized = resolve(path).replaceAll('\\', '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

if (records.length !== 1) failures.push(`single-checkout requires exactly one registered worktree; found ${records.length}`)
const record = records[0] ?? ''
const worktree = record.match(/^worktree (.+)$/mu)?.[1]
if (worktree === undefined) {
  failures.push('the only registered worktree must be the project root')
} else {
  try {
    if (comparable(realpathSync(resolve(worktree))) !== comparable(root)) failures.push('the only registered worktree must be the project root')
  } catch {
    failures.push('the registered project worktree path is missing or unreadable')
  }
}
if (!/^branch refs\/heads\//mu.test(record)) failures.push('the project checkout must be branch-attached')

if (failures.length > 0) {
  console.error('Isolation status verification failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log('Isolation status: PASS (one branch-attached project checkout)')
}
