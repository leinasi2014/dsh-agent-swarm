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
import { EXPECTED_P0_SWARM_TOOL_NAMES, exactP0SwarmToolSurface } from './p0/tool-surface.mjs'
import { assertCompletedRootProbeTurn } from './p0/profile-probe.mjs'
import { assertP0ProfileModelRoute, profilePatchLines } from './p0/run.mjs'

const profileProbeSource = await readFile(new URL('./p0/profile-probe.mjs', import.meta.url), 'utf8')
const settledIndex = profileProbeSource.indexOf('const { fixture, settledTurn } = await settleRootAgentLoop(agent)')
const terminalSnapshotIndex = profileProbeSource.indexOf("const terminalSnapshot = await bounded('terminalSnapshot'")
const e2eEvidenceIndex = profileProbeSource.indexOf("append('w0-agent-loop-e2e'")
if (settledIndex < 0 || terminalSnapshotIndex < settledIndex || e2eEvidenceIndex < terminalSnapshotIndex) {
  throw new Error('P0 Profile fixture must sample the exact Team only after root terminal settlement')
}
const p0RunSource = await readFile(new URL('./p0/run.mjs', import.meta.url), 'utf8')
if (!p0RunSource.includes('terminalIdentity, reloadIdentity, exactInitial, exactReload')) {
  throw new Error('P0 reload failure diagnostics must include projection and exact terminal identities')
}
const profilePatch = profilePatchLines({
  storageRoot: '/isolated/storage', sessionRoot: '/isolated/sessions', workspaceRoot: '/isolated/workspace',
  shutdownProbeUrl: 'file:///isolated/shutdown-probe.mjs', serviceProbeUrl: 'file:///isolated/profile-probe.mjs', swarmEnabled: true,
})
assertP0ProfileModelRoute(profilePatch)
try {
  assertP0ProfileModelRoute(profilePatch.filter(line => line !== '- id: agent-default-model'))
  throw new Error('P0 Profile without a model route unexpectedly passed')
} catch (error) {
  if (error instanceof Error && error.message === 'P0 Profile without a model route unexpectedly passed') throw error
}
for (const terminal of [
  { seq: 52, type: 'turn/end', turn: 4, reason: { kind: 'error', message: 'fixture error' } },
  { seq: 52, type: 'turn/end', turn: 4, reason: { kind: 'cancelled' } },
]) {
  try {
    assertCompletedRootProbeTurn(terminal, [{ seq: 51, type: 'turn/start', data: { turn: 4 } }, { ...terminal, data: { turn: 4, reason: terminal.reason } }])
    throw new Error(`non-completed root terminal unexpectedly passed: ${terminal.reason.kind}`)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('non-completed root terminal unexpectedly passed')) throw error
  }
}
assertCompletedRootProbeTurn({ seq: 52, type: 'turn/end', turn: 4, reason: { kind: 'completed' } }, [])

if (!exactP0SwarmToolSurface([...EXPECTED_P0_SWARM_TOOL_NAMES].reverse()).ok) throw new Error('exact P0 tool surface rejected its complete set')
for (const [label, tools] of [
  ['missing tool', EXPECTED_P0_SWARM_TOOL_NAMES.slice(1)],
  ['replacement tool', [...EXPECTED_P0_SWARM_TOOL_NAMES.slice(1), 'agent_swarm_unknown']],
  ['extra tool', [...EXPECTED_P0_SWARM_TOOL_NAMES, 'agent_swarm_extra']],
  ['duplicate tool', [...EXPECTED_P0_SWARM_TOOL_NAMES, EXPECTED_P0_SWARM_TOOL_NAMES[0]]],
  ['non-string tool', [...EXPECTED_P0_SWARM_TOOL_NAMES.slice(1), 1]],
]) {
  if (exactP0SwarmToolSurface(tools).ok) throw new Error(`exact P0 tool surface unexpectedly passed: ${label}`)
}

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
  const fixture = {
    exactRoot: true, workspaceAttached: true, sessionNonBlank: true,
    rootSessionId: 'root', workspaceId: 'workspace', workspacePath: join(root, 'runtime', 'workspace'),
  }
  for (const relativePath of REQUIRED_P0_EVIDENCE_FILES) {
    const path = join(root, relativePath)
    const content = relativePath === 'evidence/r3-browser-active.json'
      ? `${JSON.stringify({
          status: 'pass', rootSessionId: 'root', teamId: 'team', reload: true, browser, fixture,
          officialTestingNoticePresent: true, officialTestingNoticeDismissed: true,
          officialApiKeyOnboardingPresent: true, officialApiKeyOnboardingSkipped: true,
          bootstrap: { ...bootstrap, frameworkTargetObserved: true },
          handoff: {
            officialSessionSelected: true, officialSelectionSource: 'localStorage:dsh.sessions.current',
            currentSessionId: 'root', reloadedSessionId: 'root', chatTextboxVisible: true,
          },
          keyboard: ['focus', 'enter', 'focus-chat', 'enter-chat', 'escape'],
          surfaces: {
            wideDetailsLease: true, toolHandoff: true, narrowNativeDetailsConcession: true,
            narrowSubtreeMountedHidden: true, noPluginFallbackOverlay: true, samePanelRestored: true,
            chatReflow: true, localeRerendered: true, disconnectRecovery: true,
          },
          requests: [{ method: 'POST', body: { method: 'snapshot' } }],
          faultInjection: { recovered: true, expectedConsoleErrors: ['Failed to load resource: net::ERR_CONNECTION_FAILED'] },
          consoleErrors: [], pageErrors: [], visibleErrors: { activeDashboard: [], initialCaptainChat: [], reloadDashboard: [], reloadCaptainChat: [] },
        })}\n`
      : relativePath === 'evidence/r3-browser-r0.json'
        ? `${JSON.stringify({
            status: 'pass', browser, bootstrap, routeUnavailable: true,
            routeObserved: { status: 405, bodyBytes: 0, contentType: null },
            routeOwner: 'official-host-fallback', swarmRouteRegistered: false,
            teamActionAbsent: true, renderedData: false,
            officialTestingNoticePresent: true, officialTestingNoticeDismissed: true,
            officialApiKeyOnboardingPresent: true, officialApiKeyOnboardingSkipped: true,
            consoleErrors: [], pageErrors: [], visibleErrors: [],
          })}\n`
        : relativePath === 'evidence/r3-browser-removed.json'
          ? `${JSON.stringify({
              status: 'pass', browser, bootstrap, teamActionAbsent: true, consoleErrors: [], pageErrors: [], visibleErrors: [],
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
    status: 'pass', rootSessionId: 'root', teamId: 'team', reload: true, browser, fixture,
    officialTestingNoticePresent: true, officialTestingNoticeDismissed: true,
    officialApiKeyOnboardingPresent: true, officialApiKeyOnboardingSkipped: true,
    bootstrap: { ...bootstrap, frameworkTargetObserved: true },
    handoff: {
      officialSessionSelected: true, officialSelectionSource: 'localStorage:dsh.sessions.current',
      currentSessionId: 'root', reloadedSessionId: 'root', chatTextboxVisible: true,
    },
    keyboard: ['focus', 'enter', 'focus-chat', 'enter-chat', 'escape'],
    surfaces: {
      wideDetailsLease: true, toolHandoff: true, narrowNativeDetailsConcession: true,
      narrowSubtreeMountedHidden: true, noPluginFallbackOverlay: true, samePanelRestored: true,
      chatReflow: true, localeRerendered: true, disconnectRecovery: true,
    },
    requests: [{ method: 'POST', body: { method: 'control.write' } }],
    faultInjection: { recovered: true, expectedConsoleErrors: ['Failed to load resource: net::ERR_CONNECTION_FAILED'] },
    consoleErrors: [], pageErrors: [], visibleErrors: { activeDashboard: [], initialCaptainChat: [], reloadDashboard: [], reloadCaptainChat: [] },
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
  const missingVisibleStageContent = `${JSON.stringify({
    ...JSON.parse(activeContent.toString('utf8')),
    visibleErrors: { activeDashboard: [], initialCaptainChat: [], reloadDashboard: [] },
  })}\n`
  await writeFile(activePath, missingVisibleStageContent)
  activeRecord.bytes = Buffer.byteLength(missingVisibleStageContent)
  activeRecord.sha256 = await sha256File(activePath)
  if ((await verifyP0Evidence(root, structuredClone(base), expected)).ok) throw new Error('R3 missing visible-error stage unexpectedly passed')
  await writeFile(activePath, activeContent)
  activeRecord.bytes = activeContent.length
  activeRecord.sha256 = await sha256File(activePath)
  cases.push(['R3 missing visible-error stage'])
  const fallbackSurfaceContent = `${JSON.stringify({
    ...JSON.parse(activeContent.toString('utf8')),
    surfaces: { ...JSON.parse(activeContent.toString('utf8')).surfaces, noPluginFallbackOverlay: false },
  })}\n`
  await writeFile(activePath, fallbackSurfaceContent)
  activeRecord.bytes = Buffer.byteLength(fallbackSurfaceContent)
  activeRecord.sha256 = await sha256File(activePath)
  if ((await verifyP0Evidence(root, structuredClone(base), expected)).ok) throw new Error('R3 fallback-overlay evidence unexpectedly passed')
  await writeFile(activePath, activeContent)
  activeRecord.bytes = activeContent.length
  activeRecord.sha256 = await sha256File(activePath)
  cases.push(['R3 browser fallback-overlay evidence'])
  for (const [label, visibleErrors] of [
    ['R3 initial Captain Chat history loading error', { activeDashboard: [], initialCaptainChat: ['Failed to load history'], reloadDashboard: [], reloadCaptainChat: [] }],
    ['R3 reload Captain Chat turn failure', { activeDashboard: [], initialCaptainChat: [], reloadDashboard: [], reloadCaptainChat: ['This turn failed'] }],
  ]) {
    const content = `${JSON.stringify({ ...JSON.parse(activeContent.toString('utf8')), visibleErrors })}\n`
    await writeFile(activePath, content)
    activeRecord.bytes = Buffer.byteLength(content)
    activeRecord.sha256 = await sha256File(activePath)
    if ((await verifyP0Evidence(root, structuredClone(base), expected)).ok) throw new Error(`${label} unexpectedly passed`)
    await writeFile(activePath, activeContent)
    activeRecord.bytes = activeContent.length
    activeRecord.sha256 = await sha256File(activePath)
    cases.push([label])
  }
  const detachedFixtureContent = `${JSON.stringify({
    ...JSON.parse(activeContent.toString('utf8')),
    fixture: { ...fixture, sessionNonBlank: false },
  })}\n`
  await writeFile(activePath, detachedFixtureContent)
  activeRecord.bytes = Buffer.byteLength(detachedFixtureContent)
  activeRecord.sha256 = await sha256File(activePath)
  if ((await verifyP0Evidence(root, structuredClone(base), expected)).ok) {
    throw new Error('R3 browser detached/blank fixture unexpectedly passed')
  }
  await writeFile(activePath, activeContent)
  activeRecord.bytes = activeContent.length
  activeRecord.sha256 = await sha256File(activePath)
  cases.push(['R3 browser detached/blank fixture'])
  const r0Path = join(root, 'evidence/r3-browser-r0.json')
  const r0Record = base.evidenceFiles.find(record => record.relativePath === 'evidence/r3-browser-r0.json')
  const r0Content = await readFile(r0Path)
  const r0Base = JSON.parse(r0Content.toString('utf8'))
  for (const [label, mutate] of [
    ['R0 fallback nonempty body', value => { value.routeObserved.bodyBytes = 1 }],
    ['R0 fallback fake content-type', value => { value.routeObserved.contentType = 'application/json' }],
    ['R0 fallback fake owner', value => { value.routeOwner = 'dsh-agent-swarm' }],
    ['R0 fallback fake registration', value => { value.swarmRouteRegistered = true }],
  ]) {
    const value = structuredClone(r0Base)
    mutate(value)
    const content = `${JSON.stringify(value)}\n`
    await writeFile(r0Path, content)
    r0Record.bytes = Buffer.byteLength(content)
    r0Record.sha256 = await sha256File(r0Path)
    if ((await verifyP0Evidence(root, structuredClone(base), expected)).ok) {
      throw new Error(`${label} unexpectedly passed`)
    }
    cases.push([label])
  }
  await writeFile(r0Path, r0Content)
  r0Record.bytes = r0Content.length
  r0Record.sha256 = await sha256File(r0Path)
  for (const [relativePath, label] of [
    ['evidence/r3-browser-r0.json', 'R0 visible turn failure'],
    ['evidence/r3-browser-removed.json', 'removed visible turn failure'],
  ]) {
    const path = join(root, relativePath)
    const record = base.evidenceFiles.find(value => value.relativePath === relativePath)
    const original = await readFile(path)
    const content = `${JSON.stringify({ ...JSON.parse(original.toString('utf8')), visibleErrors: ['This turn failed'] })}\n`
    await writeFile(path, content)
    record.bytes = Buffer.byteLength(content)
    record.sha256 = await sha256File(path)
    if ((await verifyP0Evidence(root, structuredClone(base), expected)).ok) throw new Error(`${label} unexpectedly passed`)
    await writeFile(path, original)
    record.bytes = original.length
    record.sha256 = await sha256File(path)
    cases.push([label])
  }
  console.log(`P0 Bundle/evidence gates: Typert payload + 1 positive/2 negative response cases; 1 safe Bundle + 4 unsafe Bundle cases; positive evidence + ${cases.length} negative evidence cases: PASS`)
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
