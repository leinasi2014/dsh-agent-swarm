import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, delimiter, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const scratch = await mkdtemp(join(tmpdir(), 'dsh-agent-swarm-package-install-'))

function pnpmCli() {
  const pathEntries = (process.env.PNPM_HOME === undefined ? [] : [process.env.PNPM_HOME])
    .concat((process.env.Path ?? process.env.PATH ?? '').split(delimiter))
  for (const entry of pathEntries) {
    const candidate = join(entry, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
    if (existsSync(candidate)) return candidate
  }
  throw new Error('pnpm CLI cannot be resolved from PNPM_HOME or PATH')
}

function run(command, args, cwd) {
  return new Promise((resolveRun, reject) => {
    const executable = command === 'pnpm' ? process.execPath : command
    const commandArgs = command === 'pnpm' ? [pnpmCli(), ...args] : args
    const child = spawn(executable, commandArgs, { cwd })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('close', code => resolveRun({ code, stdout, stderr }))
  })
}

async function writeConsumer(directory, name) {
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name, private: true, version: '0.0.0' }, null, 2) + '\n')
}

async function hasInstalledPackage(directory) {
  try {
    await access(join(directory, 'node_modules', 'dsh-agent-swarm', 'package.json'))
    return true
  } catch {
    return false
  }
}

try {
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  if (packageJson.scripts?.postinstall !== undefined) {
    throw new Error('published package must not declare a postinstall script')
  }
  if (packageJson.scripts?.['hooks:install'] !== 'lefthook install') {
    throw new Error('development hook installation must remain explicit via hooks:install')
  }

  const artifactDir = join(scratch, 'artifact')
  const consumerDir = join(scratch, 'consumer')
  const failedConsumerDir = join(scratch, 'failed-consumer')
  await Promise.all([
    writeConsumer(consumerDir, 'dsh-agent-swarm-package-install-consumer'),
    writeConsumer(failedConsumerDir, 'dsh-agent-swarm-package-install-failed-consumer'),
  ])

  const packed = await run('pnpm', ['pack', '--pack-destination', artifactDir], root)
  if (packed.code !== 0) throw new Error(`pnpm pack failed (exit ${packed.code}): ${packed.stdout}${packed.stderr}`)
  const packedName = /dsh-agent-swarm-[^\s]+\.tgz/.exec(packed.stdout)?.[0]
  if (packedName === undefined) throw new Error(`pnpm pack emitted no dsh-agent-swarm tarball: ${packed.stdout}`)
  const tarball = join(artifactDir, basename(packedName))

  // Deliberately omit --ignore-scripts: this is the consumer lifecycle contract.
  const installed = await run('pnpm', ['add', tarball], consumerDir)
  const installOutput = installed.stdout + installed.stderr
  if (installed.code !== 0) throw new Error(`normal tarball install failed (exit ${installed.code}): ${installOutput}`)
  if (/lefthook|ELIFECYCLE/i.test(installOutput)) {
    throw new Error(`normal tarball install reported forbidden lifecycle output: ${installOutput}`)
  }
  const consumerPackage = JSON.parse(await readFile(join(consumerDir, 'package.json'), 'utf8'))
  if (consumerPackage.dependencies?.['dsh-agent-swarm'] === undefined || !await hasInstalledPackage(consumerDir)) {
    throw new Error('normal tarball install did not materialize its dependency registration')
  }
  const installedManifest = JSON.parse(await readFile(join(consumerDir, 'node_modules', 'dsh-agent-swarm', 'package.json'), 'utf8'))
  if (installedManifest.scripts?.postinstall !== undefined) {
    throw new Error('installed tarball retained a production postinstall script')
  }

  // A corrupt tarball must fail without half-registering this package in an
  // otherwise fresh consumer project.
  const corruptTarball = join(scratch, 'corrupt-dsh-agent-swarm.tgz')
  await writeFile(corruptTarball, 'not a tarball\n', 'utf8')
  const failed = await run('pnpm', ['add', corruptTarball], failedConsumerDir)
  if (failed.code === 0) throw new Error('corrupt tarball unexpectedly installed')
  const failedConsumerPackage = JSON.parse(await readFile(join(failedConsumerDir, 'package.json'), 'utf8'))
  if (failedConsumerPackage.dependencies?.['dsh-agent-swarm'] !== undefined || await hasInstalledPackage(failedConsumerDir)) {
    throw new Error('failed tarball install left a half-registered dsh-agent-swarm dependency')
  }

  console.log(`Package tarball normal install and failed-install rollback: PASS (${packedName})`)
} finally {
  await rm(scratch, { recursive: true, force: true })
}
