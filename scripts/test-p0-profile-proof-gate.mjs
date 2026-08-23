import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REQUIRED_P0_GATES, sha256File, verifyP0Evidence } from './p0/evidence.mjs'

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
    ['runtime retained', manifest => { manifest.cleanup.runtimeRemoved = false }],
  ]
  for (const [label, mutate] of cases) {
    const manifest = structuredClone(base)
    mutate(manifest)
    const result = await verifyP0Evidence(root, manifest)
    if (result.ok) throw new Error(`negative fixture unexpectedly passed: ${label}`)
  }
  console.log(`P0 evidence gate positive fixture and ${cases.length} negative cases: PASS`)
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
