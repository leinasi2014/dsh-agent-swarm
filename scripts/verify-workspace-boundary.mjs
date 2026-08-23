import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))

export function validateWorkspaceBoundary({
  projectRoot,
  workspaceRoot,
  workspaceDefinition,
  expectedVitestRange,
  vitestVersion,
  vitestLocator,
}) {
  const failures = []
  if (resolve(workspaceRoot) !== resolve(projectRoot, 'node_modules')) {
    failures.push('pnpm workspace root escapes the independent plugin')
  }
  if (workspaceDefinition.trim() !== 'packages: []') {
    failures.push('pnpm-workspace.yaml must declare the plugin as a standalone workspace root')
  }
  if (!/^\^?3(?:\.|$)/.test(expectedVitestRange)) {
    failures.push('the plugin manifest must retain Vitest 3.x as its own resolved toolchain')
  }
  if (!/^vitest\/3\./.test(vitestVersion.trim())) {
    failures.push('pnpm exec did not resolve the plugin Vitest 3.x executable')
  }
  const locatorRelative = relative(projectRoot, resolve(vitestLocator))
  if (locatorRelative === '' || locatorRelative === '..' || locatorRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(locatorRelative)) {
    failures.push('pnpm exec resolved Vitest outside the independent plugin')
  }
  return failures
}

async function pnpm(args) {
  const pnpmEntrypoint = process.env.npm_execpath
  if (pnpmEntrypoint === undefined || pnpmEntrypoint === '') {
    throw new Error('workspace verification must be invoked through the pinned pnpm script')
  }
  const { stdout } = await execFileAsync(process.execPath, [pnpmEntrypoint, ...args], {
    cwd: root,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  })
  return stdout.trim()
}

async function main() {
  const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
  const workspaceDefinition = await readFile(resolve(root, 'pnpm-workspace.yaml'), 'utf8')
  const workspaceRoot = await pnpm(['root', '-w'])
  const vitestVersion = await pnpm(['exec', 'vitest', '--version'])
  const vitestLocator = await pnpm(['exec', 'node', '-p', "require.resolve('vitest/package.json')"])
  const failures = validateWorkspaceBoundary({
    projectRoot: root,
    workspaceRoot,
    workspaceDefinition,
    expectedVitestRange: manifest.devDependencies?.vitest ?? '',
    vitestVersion,
    vitestLocator,
  })
  if (failures.length > 0) {
    console.error('Independent pnpm workspace verification failed:')
    for (const failure of failures) console.error(`- ${failure}`)
    process.exitCode = 1
    return
  }
  console.log('Independent pnpm workspace and plugin-local Vitest 3.x resolution: PASS')
}

const invokedAs = process.argv[1] === undefined ? undefined : resolve(process.argv[1])
const selfPath = fileURLToPath(import.meta.url)
const isDirectRun = invokedAs !== undefined
  && (process.platform === 'win32' ? invokedAs.toLowerCase() === selfPath.toLowerCase() : invokedAs === selfPath)
if (isDirectRun) await main()
