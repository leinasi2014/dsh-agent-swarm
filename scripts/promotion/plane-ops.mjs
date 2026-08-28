// Stable-plane operations shared by promote/rollback/status (issue #102):
// install a frozen tarball into the STABLE control Profile (remove+add, the
// OQ-2 mitigation against same-name same-version re-resolution), write its
// storage-root isolation patch, and run the post-switch health probe
// (dump-config assembly identity + boot + host.describe RPC).
//
// The stable Profile lives entirely under <dogfood-root>/control/home —
// ~/.dsh is never an input or an output of anything here (red line 14).
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { bootPlane, run, stopPlane, waitPortFree } from './runner.mjs'
import { rpcCall } from './lib.mjs'

const PROFILE_NAME = 'web'

function forwardSlashes(path) {
  return path.replaceAll('\\', '/')
}

/** The stable profile's storage isolation patch (M1D-1 §3.2 form). */
export async function writeStablePatch(layout) {
  const patchPath = join(layout.controlProfileDir, 'cordis.patch.yml')
  await writeFile(patchPath, [
    `# M3-3 stable control-plane storage roots (issue #102): the web template's`,
    `# storage rows are re-rooted into the CONTROL domain's dedicated roots.`,
    `# The last-known-good pointer lives in lkg/lkg.json; never in ~/.dsh.`,
    `- id: storage-json`,
    `  config:`,
    `    root: '${forwardSlashes(layout.controlStorage)}'`,
    `- id: session-persistence-jsonl`,
    `  config:`,
    `    root: '${forwardSlashes(layout.controlSessions)}'`,
    ``,
  ].join('\n'), 'utf8')
  return patchPath
}

/**
 * Install one frozen tarball into the stable control Profile. Uses remove+add
 * (never an in-place `link:`/junction — the bytes are materialized fresh by
 * pnpm from the tarball), then (re)writes the storage isolation patch.
 */
export async function installIntoStableProfile({ cli, layout, tarballPath }) {
  const env = { DSH_HOME: layout.controlHome }
  const manifestPath = join(layout.controlProfileDir, 'package.json')
  const existing = await readFile(manifestPath, 'utf8').then(text => JSON.parse(text), () => undefined)
  let removeResult
  if (existing?.dependencies?.['dsh-agent-swarm'] !== undefined) {
    removeResult = await run(process.execPath, [cli, 'plugin', '--profile', PROFILE_NAME, 'remove', '-w', 'dsh-agent-swarm'], { env, timeoutMs: 10 * 60_000 })
  }
  const addResult = await run(process.execPath, [cli, 'plugin', '--profile', PROFILE_NAME, 'add', '-w', tarballPath], { env, timeoutMs: 10 * 60_000 })
  if (addResult.code !== 0) {
    return { ok: false, step: 'add', addResult, removeResult }
  }
  await writeStablePatch(layout)
  const dump = await run(process.execPath, [cli, '--profile', PROFILE_NAME, '--dump-config'], { env })
  const dumpOk = dump.code === 0 && dump.stdout.includes('dsh-agent-swarm') && dump.stdout.includes(forwardSlashes(layout.controlStorage)) && dump.stdout.includes(forwardSlashes(layout.controlSessions))
  return { ok: dumpOk, step: 'dump-config', dump, dumpOk, addResult, removeResult }
}

/**
 * The stable-plane health probe: boot the control Profile on its dedicated
 * port and answer host.describe. Returns evidence; teardown is bounded and
 * the port-free state is asserted inside the evidence.
 */
export async function probeStablePlane({ cli, layout, port }) {
  const env = { DSH_HOME: layout.controlHome }
  const dump = await run(process.execPath, [cli, '--profile', PROFILE_NAME, '--dump-config'], { env })
  const boot = await bootPlane({ cli, home: layout.controlHome, profile: PROFILE_NAME, port })
  let describe = { ok: false }
  if (boot.ready) describe = await rpcCall(port, 'host.describe', {})
  // host.describe's `home` is the host account home by contract (packages/host
  // apiproxy host.ts), NOT DSH_HOME — the control-identity evidence here is
  // the dump-config assembly (storage roots pointed at the CONTROL domain).
  const evidence = {
    dumpConfigExit: dump.code,
    dumpConfigOk: dump.code === 0 && dump.stdout.includes('dsh-agent-swarm'),
    bootReady: boot.ready,
    bootMs: boot.bootMs,
    describe: describe.body,
    stderrExcerpt: boot.stderr().slice(0, 2_000),
  }
  const teardown = await stopPlane(boot)
  evidence.teardown = teardown
  evidence.portFreeAfterTeardown = await waitPortFree(port, 15_000, '127.0.0.1', { reclaim: true })
  return { ok: evidence.dumpConfigOk && boot.ready && describe.ok && teardown.exited && evidence.portFreeAfterTeardown, evidence }
}
