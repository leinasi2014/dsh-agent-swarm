import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { REQUIRED_P0_GATES, sha256File, verifyP0Evidence } from './p0/evidence.mjs'
import { verifySafeBundlePatch } from './p0/bundle-shape.mjs'
import { parsePluginInventoryResponse, pluginInventoryPayload } from './p0/inventory.mjs'

if (JSON.stringify(pluginInventoryPayload()) !== JSON.stringify({ args: {} })) throw new Error('Typert inventory payload shape drifted')
for (const invalidResponse of [
  { ok: false, httpStatus: 200, body: { result: { ok: false, error: { code: 'internal', message: 'fixture' } } } },
  { ok: true, httpStatus: 200, body: { result: { ok: true, value: {} } } },
]) {
  try {
    parsePluginInventoryResponse(invalidResponse)
    throw new Error('invalid inventory response unexpectedly passed')
  } catch (error) {
    if (error instanceof Error && error.message === 'invalid inventory response unexpectedly passed') throw error
  }
}
const inventoryFixture = parsePluginInventoryResponse({
  ok: true, httpStatus: 200, body: { result: { ok: true, value: { entries: [] } } },
})
if (inventoryFixture.length !== 0) throw new Error('valid empty inventory response did not pass')

const safeBundle = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
if (!verifySafeBundlePatch(safeBundle).ok) throw new Error('repository Bundle does not match the default-disabled structural group')
for (const [label, broken] of [
  ['enabled by default', safeBundle.replace('disabled: true', 'disabled: false')],
  ['plugin as group', safeBundle.replace('name: cordis:group', 'name: dsh-agent-swarm')],
  ['missing structural flag', safeBundle.replace('      group: true\n', '')],
  ['wrong child', safeBundle.replace('id: agent-swarm-runtime', 'id: alternate-runtime')],
]) {
  if (verifySafeBundlePatch(broken).ok) throw new Error(`unsafe Bundle fixture unexpectedly passed: ${label}`)
}

const root = await mkdtemp(join(tmpdir(), 'swarm-p0-evidence-gate-'))
try {
  await mkdir(join(root, 'artifact'), { recursive: true })
  const artifact = join(root, 'artifact', 'dsh-agent-swarm.tgz')
  await writeFile(artifact, 'fixture artifact')
  const base = {
    schemaVersion: 1,
    status: 'pass',
    candidate: { commit: 'a'.repeat(40), tree: 'b'.repeat(40), cleanBefore: true, cleanAfter: true },
    artifact: { relativePath: 'artifact/dsh-agent-swarm.tgz', sha256: await sha256File(artifact), bytes: 16 },
    official: {
      commitBefore: 'c'.repeat(40), commitAfter: 'c'.repeat(40),
      treeBefore: 'd'.repeat(40), treeAfter: 'd'.repeat(40),
      statusBefore: '', statusAfter: '', version: '0.1.1-rc.2',
    },
    isolation: {
      runtimeRoot: join(root, 'runtime'), dshHome: join(root, 'runtime', 'home'),
      workspaceRoot: join(root, 'runtime', 'workspace'), sandboxRoot: join(root, 'runtime', 'workspace'),
      storageRoot: join(root, 'runtime', 'state', 'storage'), sessionRoot: join(root, 'runtime', 'state', 'sessions'),
      probeModuleRoot: join(root, 'runtime', 'P0 probe 探针'),
      probeModuleUrls: [
        pathToFileURL(join(root, 'runtime', 'P0 probe 探针', 'shutdown probe.mjs')).href,
        pathToFileURL(join(root, 'runtime', 'P0 probe 探针', 'service probe.mjs')).href,
      ],
      defaultDshHome: join(root, 'default-home'),
    },
    gates: REQUIRED_P0_GATES.map(name => ({ name, status: 'pass' })),
    cleanup: { runtimeRemoved: true, portFree: true, artifactRetained: true, evidenceRetained: true },
  }
  const positive = await verifyP0Evidence(root, structuredClone(base))
  if (!positive.ok) throw new Error(`positive fixture failed: ${positive.failures.join('; ')}`)

  const cases = [
    ['digest mismatch', manifest => { manifest.artifact.sha256 = '0'.repeat(64) }],
    ['missing gate', manifest => { manifest.gates = manifest.gates.filter(gate => gate.name !== 'reload') }],
    ['dirty official', manifest => { manifest.official.statusAfter = ' M package.json' }],
    ['overlapping state', manifest => { manifest.isolation.storageRoot = join(manifest.isolation.workspaceRoot, 'storage') }],
    ['invalid probe URL', manifest => { manifest.isolation.probeModuleUrls[0] = 'https://example.invalid/probe.mjs' }],
    ['runtime retained', manifest => { manifest.cleanup.runtimeRemoved = false }],
  ]
  for (const [label, mutate] of cases) {
    const manifest = structuredClone(base)
    mutate(manifest)
    const result = await verifyP0Evidence(root, manifest)
    if (result.ok) throw new Error(`negative fixture unexpectedly passed: ${label}`)
  }
  console.log(`P0 Bundle/evidence gates: Typert payload + 1 positive/2 negative response cases; 1 safe Bundle + 4 unsafe Bundle cases; positive evidence + ${cases.length} negative evidence cases: PASS`)
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
