import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function gitOptional(args, cwd) {
  try {
    return git(args, cwd)
  } catch {
    return ''
  }
}

function comparable(path) {
  const normalized = resolve(path).replaceAll('\\', '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function insideDirectChild(parent, child) {
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel) && !rel.includes(sep)
}

const currentRoot = resolve(git(['rev-parse', '--show-toplevel'], process.cwd()))
const fields = execFileSync('git', ['worktree', 'list', '--porcelain', '-z'], {
  cwd: currentRoot,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
}).split('\0')
const worktrees = fields.filter(field => field.startsWith('worktree ')).map(field => resolve(field.slice(9)))
const failures = []

if (worktrees.length === 0) failures.push('git worktree list returned no main worktree')
const mainRoot = worktrees[0]
const worktreeRoot = mainRoot === undefined ? undefined : join(mainRoot, '.worktree')

const ignorePath = join(currentRoot, '.gitignore')
if (!existsSync(ignorePath)) {
  failures.push('.gitignore is missing; /.worktree/ must be ignored before parallel work starts')
} else {
  const patterns = readFileSync(ignorePath, 'utf8')
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('#'))
  if (!patterns.includes('.worktree/') && !patterns.includes('/.worktree/')) {
    failures.push('.gitignore must contain /.worktree/ before any worktree is created')
  }
}

if (mainRoot !== undefined && worktreeRoot !== undefined) {
  const seen = new Set()
  const mainCommon = comparable(realpathSync(resolve(mainRoot, git(['rev-parse', '--git-common-dir'], mainRoot))))
  const realMain = realpathSync(mainRoot)
  const realContainer = existsSync(worktreeRoot) ? realpathSync(worktreeRoot) : worktreeRoot

  for (const path of worktrees) {
    const key = comparable(path)
    if (seen.has(key)) failures.push(`duplicate registered worktree path: ${path}`)
    seen.add(key)
    if (!existsSync(path)) {
      failures.push(`registered worktree path is missing: ${path}`)
      continue
    }
    const common = comparable(realpathSync(resolve(path, git(['rev-parse', '--git-common-dir'], path))))
    if (common !== mainCommon) failures.push(`worktree uses a foreign Git common directory: ${path}`)
    if (comparable(path) === comparable(mainRoot)) continue
    if (!insideDirectChild(worktreeRoot, path)) {
      failures.push(`worktree must be a direct child of ${worktreeRoot}: ${path}`)
      continue
    }
    const task = basename(path)
    if (!/^[a-z0-9][a-z0-9._-]*$/u.test(task)) failures.push(`worktree task directory is not a stable slug: ${path}`)
    const realPath = realpathSync(path)
    if (!insideDirectChild(realContainer, realPath)) failures.push(`worktree resolves outside ${realContainer}: ${path}`)
    if (gitOptional(['symbolic-ref', '--short', '-q', 'HEAD'], path) === '') failures.push(`development worktree must own a branch: ${path}`)
  }

  const siblingPrefixes = [`${basename(realMain)}-wt-`, `${basename(realMain)}-worktree-`]
  for (const entry of readdirSync(dirname(realMain), { withFileTypes: true })) {
    if (siblingPrefixes.some(prefix => entry.name.startsWith(prefix))) {
      failures.push(`legacy or orphan sibling worktree is forbidden: ${join(dirname(realMain), entry.name)}`)
    }
  }
}

if (failures.length > 0) {
  console.error('Worktree governance verification failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log(`Worktree governance: PASS (${worktrees.length} registered; all task worktrees under ${worktreeRoot})`)
}
