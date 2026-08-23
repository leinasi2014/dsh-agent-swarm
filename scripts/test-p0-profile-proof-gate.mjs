import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  EXPECTED_P0_OFFICIAL_COMMIT, EXPECTED_P0_OFFICIAL_TREE,
  REQUIRED_P0_EVIDENCE_FILES, REQUIRED_P0_GATES, sha256File, verifyP0Evidence,
} from './p0/evidence.mjs'
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
  const evidenceFiles = []
  const browser = { engine: 'chromium', executablePath: join(root, 'browser', 'chrome.exe'), version: '1.2.3.4' }
  const selectionSource = {
    relativePath: 'packages/client/runtime/src/client/sessions/service.ts',
    gitBlob: 'c66da4e0d3376d4d23f403d6651769fa53cee5fe',
    sha256: 'a4531ae9de0423400d3c641a5115a4a97b852276781a53fc2cfdbd4e34ba6b82',
  }
  const bootstrap = {
    key: 'dsh.sessions.current', value: { sessionId: 'root' },
    purpose: 'isolated-proof-initial-ui-selection', authority: false, officialSource: selectionSource,
  }
  for (const relativePath of REQUIRED_P0_EVIDENCE_FILES) {
    const path = join(root, relativePath)
    const content = relativePath === 'evidence/r3-browser-active.json'
      ? `${JSON.stringify({
          status: 'pass', rootSessionId: 'root', teamId: 'team', reload: true, browser,
          officialTestingNoticePresent: true, officialTestingNoticeDismissed: true,
          officialApiKeyOnboardingPresent: true, officialApiKeyOnboardingSkipped: true,
          bootstrap: { ...bootstrap, frameworkTargetObserved: true },
          handoff: {
            officialSessionSelected: true, officialSelectionSource: 'localStorage:dsh.sessions.current',
            currentSessionId: 'root', reloadedSessionId: 'root', chatTextboxVisible: true,
          },
          keyboard: ['focus', 'enter', 'focus-chat', 'enter-chat', 'escape'],
          requests: [{ method: 'POST', body: { method: 'snapshot' } }],
          consoleErrors: [], pageErrors: [],
        })}\n`
      : relativePath === 'evidence/r3-browser-r0.json'
        ? `${JSON.stringify({
            status: 'pass', browser, bootstrap, routeUnavailable: true, renderedData: false,
            officialTestingNoticePresent: true, officialTestingNoticeDismissed: true,
            officialApiKeyOnboardingPresent: true, officialApiKeyOnboardingSkipped: true,
            consoleErrors: [], pageErrors: [],
          })}\n`
        : relativePath === 'evidence/r3-browser-removed.json'
          ? `${JSON.stringify({
              status: 'pass', browser, bootstrap, teamActionAbsent: true, consoleErrors: [], pageErrors: [],
              officialTestingNoticePresent: true, officialTestingNoticeDismissed: true,
              officialApiKeyOnboardingPresent: true, officialApiKeyOnboardingSkipped: true,
            })}\n`
          : relativePath.endsWith('.png') ? Buffer.alloc(1_024, 1) : `fixture evidence: ${relativePath}\n`
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
    evidenceFiles.push({ relativePath, bytes: Buffer.byteLength(content), sha256: await sha256File(path) })
  }
  const base = {
    schemaVersion: 1,
    status: 'pass',
    candidate: { commit: 'a'.repeat(40), tree: 'b'.repeat(40), cleanBefore: true, cleanAfter: true },
    artifact: { relativePath: 'artifact/dsh-agent-swarm.tgz', sha256: await sha256File(artifact), bytes: 16 },
    official: {
      commitBefore: EXPECTED_P0_OFFICIAL_COMMIT, commitAfter: EXPECTED_P0_OFFICIAL_COMMIT,
      treeBefore: EXPECTED_P0_OFFICIAL_TREE, treeAfter: EXPECTED_P0_OFFICIAL_TREE,
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
    commands: [
      ['cli-version', 0], ['candidate-build', 0], ['candidate-pack', 0], ['artifact-list', 0],
      ['profile-add', 0], ['dump-config', 0], ['profile-remove', 0], ['missing-storage-add', 0],
      ['missing-storage-boot', 1],
    ].map(([name, exitCode]) => ({ name, exitCode, durationMs: 1, timedOut: false })),
    gates: REQUIRED_P0_GATES.map(name => ({ name, status: 'pass' })),
    evidenceFiles,
    cleanup: { runtimeRemoved: true, portFree: true, artifactRetained: true, evidenceRetained: true },
  }
  const expected = { candidateCommit: base.candidate.commit, candidateTree: base.candidate.tree }
  const positive = await verifyP0Evidence(root, structuredClone(base), expected)
  if (!positive.ok) throw new Error(`positive fixture failed: ${positive.failures.join('; ')}`)

  const cases = [
    ['digest mismatch', manifest => { manifest.artifact.sha256 = '0'.repeat(64) }],
    ['wrong candidate commit', manifest => { manifest.candidate.commit = '9'.repeat(40) }],
    ['wrong candidate tree', manifest => { manifest.candidate.tree = '8'.repeat(40) }],
    ['wrong official commit', manifest => {
      manifest.official.commitBefore = '7'.repeat(40)
      manifest.official.commitAfter = '7'.repeat(40)
    }],
    ['wrong official tree', manifest => {
      manifest.official.treeBefore = '6'.repeat(40)
      manifest.official.treeAfter = '6'.repeat(40)
    }],
    ['missing gate', manifest => { manifest.gates = manifest.gates.filter(gate => gate.name !== 'reload') }],
    ['timed-out required command', manifest => { manifest.commands.find(command => command.name === 'candidate-pack').timedOut = true }],
    ['dirty official', manifest => { manifest.official.statusAfter = ' M package.json' }],
    ['overlapping state', manifest => { manifest.isolation.storageRoot = join(manifest.isolation.workspaceRoot, 'storage') }],
    ['invalid probe URL', manifest => { manifest.isolation.probeModuleUrls[0] = 'https://example.invalid/probe.mjs' }],
    ['runtime retained', manifest => { manifest.cleanup.runtimeRemoved = false }],
    ['missing decision evidence record', manifest => { manifest.evidenceFiles.shift() }],
    ['wrong decision evidence digest', manifest => { manifest.evidenceFiles[0].sha256 = '1'.repeat(64) }],
  ]
  for (const [label, mutate] of cases) {
    const manifest = structuredClone(base)
    mutate(manifest)
    const result = await verifyP0Evidence(root, manifest, expected)
    if (result.ok) throw new Error(`negative fixture unexpectedly passed: ${label}`)
  }
  const tamperedPath = join(root, REQUIRED_P0_EVIDENCE_FILES[0])
  const originalTamperedContent = await readFile(tamperedPath)
  await writeFile(tamperedPath, 'tampered decision evidence\n', 'utf8')
  const tampered = await verifyP0Evidence(root, structuredClone(base), expected)
  if (tampered.ok) throw new Error('tampered decision evidence file unexpectedly passed')
  await writeFile(tamperedPath, originalTamperedContent)
  cases.push(['tampered decision evidence file'])
  const activePath = join(root, 'evidence/r3-browser-active.json')
  const activeRecord = base.evidenceFiles.find(record => record.relativePath === 'evidence/r3-browser-active.json')
  const activeContent = await readFile(activePath)
  const nonReadContent = `${JSON.stringify({
    status: 'pass', rootSessionId: 'root', teamId: 'team', reload: true, browser,
    officialTestingNoticePresent: true, officialTestingNoticeDismissed: true,
    officialApiKeyOnboardingPresent: true, officialApiKeyOnboardingSkipped: true,
    bootstrap: { ...bootstrap, frameworkTargetObserved: true },
    handoff: {
      officialSessionSelected: true, officialSelectionSource: 'localStorage:dsh.sessions.current',
      currentSessionId: 'root', reloadedSessionId: 'root', chatTextboxVisible: true,
    },
    keyboard: ['focus', 'enter', 'focus-chat', 'enter-chat', 'escape'],
    requests: [{ method: 'POST', body: { method: 'control.write' } }],
    consoleErrors: [], pageErrors: [],
  })}\n`
  await writeFile(activePath, nonReadContent)
  activeRecord.bytes = Buffer.byteLength(nonReadContent)
  activeRecord.sha256 = await sha256File(activePath)
  if ((await verifyP0Evidence(root, structuredClone(base), expected)).ok) {
    throw new Error('R3 browser non-read request unexpectedly passed')
  }
  await writeFile(activePath, activeContent)
  activeRecord.bytes = activeContent.length
  activeRecord.sha256 = await sha256File(activePath)
  cases.push(['R3 browser non-read request'])
  console.log(`P0 Bundle/evidence gates: Typert payload + 1 positive/2 negative response cases; 1 safe Bundle + 4 unsafe Bundle cases; positive evidence + ${cases.length} negative evidence cases: PASS`)
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
