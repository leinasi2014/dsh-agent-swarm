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
          geometry: {
            desktop: {
              card: { x: 1080, y: 0, width: 360, height: 1000 },
              trigger: { x: 1000, y: 20, width: 32, height: 32 },
              frame: { collapsed: false, columns: [220, 860, 360], box: { x: 0, y: 0, width: 1440, height: 1000 } },
              composer: { x: 300, y: 800, width: 700, height: 100 },
            },
            toolDetails: {
              frame: { collapsed: false, columns: [220, 860, 360], box: { x: 0, y: 0, width: 1440, height: 1000 } },
              transitionTrace: [{ collapsed: false, columns: '220px 860px 360px' }],
            },
            closed: {
              frame: { collapsed: true, columns: [220, 1220, 0], box: { x: 0, y: 0, width: 1440, height: 1000 } },
            },
            narrow: {
              panel: { x: 680, y: 0, width: 0, height: 900 },
              panelVisible: false,
              trigger: { x: 630, y: 20, width: 32, height: 32 },
              frame: { collapsed: true, columns: [60, 620, 0], box: { x: 0, y: 0, width: 680, height: 900 } },
            },
          },
          nonModal: { ariaModal: false, dockedChatInteractionPreserved: true, officialComposerFocused: true },
          surfaces: {
            wideTeamUsesOfficialDetailsColumn: true, toolHandoffKeptDetailsOpen: true,
            toolHandoffFocusRetained: true,
            narrowTeamUsesOfficialConcession: true, floatingTeamSurfaceAbsent: true,
          },
          locale: { sequence: ['en', 'zh-CN', 'en'], sameDashboardElement: true, settingsFollowedDsh: true },
          populated: {
            initial: { member: 'profile-reviewer', rosterCount: 1, memoryCount: 2, scopes: ['team', 'member'], persistedReadback: false },
            reload: { member: 'profile-reviewer', rosterCount: 1, memoryCount: 2, scopes: ['team', 'member'], persistedReadback: true },
            fixture: {
              source: 'synthetic-authoritative-storage-fixture', mode: 'seeded',
              claimCeiling: 'member profile and memory projection/persistence; not live subagent execution',
            },
          },
          settings: {
            initial: {
              memoryQueryMaxCandidates: '7', memoryQueryTimeoutMs: '3000',
              memberDenyTools: 'agent_swarm_list_tasks', memberSkills: 'dsh-plugin-development',
              persistedReadback: true,
            },
            reload: {
              memoryQueryMaxCandidates: '7', memoryQueryTimeoutMs: '3000',
              memberDenyTools: 'agent_swarm_list_tasks', memberSkills: 'dsh-plugin-development',
              persistedReadback: true,
            },
          },
          theme: {
            light: { dark: false, layerToken: '#fff', cardBackground: 'rgb(255, 255, 255)' },
            dark: { dark: true, layerToken: '#111', cardBackground: 'rgb(17, 17, 17)' },
            systemLight: { dark: false, layerToken: '#fff', cardBackground: 'rgb(255, 255, 255)' },
            systemDark: { dark: true, layerToken: '#111', cardBackground: 'rgb(17, 17, 17)' },
          },
          keyboard: [
            'focus Team', 'Enter', 'focus Chat while docked', 'focus Tool details', 'trigger reopen',
            'trigger close', 'trigger reopen',
            'Escape with focus return', 'Enter', 'focus Open Captain Chat',
            'Enter', 'Escape after reload',
          ],
          requests: [{ method: 'POST', body: { method: 'snapshot' } }],
          consoleErrors: [], pageErrors: [],
        })}\n`
        : relativePath === 'evidence/r3-browser-profile-reload.json'
          ? `${JSON.stringify({
              status: 'pass', rootSessionId: 'root', teamId: 'team', browser, fixture,
              officialTestingNoticePresent: true, officialTestingNoticeDismissed: true,
              officialApiKeyOnboardingPresent: true, officialApiKeyOnboardingSkipped: true,
              bootstrap: { ...bootstrap, frameworkTargetObserved: true },
              representative: { source: 'synthetic-authoritative-storage-fixture', mode: 'reused' },
              populated: { member: 'profile-reviewer', rosterCount: 1, memoryCount: 2, scopes: ['team', 'member'] },
              settings: {
                memoryQueryMaxCandidates: '7', memoryQueryTimeoutMs: '3000',
                memberDenyTools: 'agent_swarm_list_tasks', memberSkills: 'dsh-plugin-development',
                persistedReadback: true,
              },
              requests: [{ method: 'POST', body: { method: 'snapshot' } }],
              consoleErrors: [], pageErrors: [],
            })}\n`
          : relativePath === 'evidence/r3-browser-r0.json'
        ? `${JSON.stringify({
            status: 'pass', browser, bootstrap, routeUnavailable: true,
            routeObserved: { status: 405, bodyBytes: 0, contentType: null },
            routeOwner: 'official-host-fallback', swarmRouteRegistered: false,
            teamActionAbsent: true, settingsCardAbsent: true, renderedData: false,
            officialTestingNoticePresent: true, officialTestingNoticeDismissed: true,
            officialApiKeyOnboardingPresent: true, officialApiKeyOnboardingSkipped: true,
            consoleErrors: [], pageErrors: [],
          })}\n`
        : relativePath === 'evidence/r3-browser-removed.json'
          ? `${JSON.stringify({
              status: 'pass', browser, bootstrap, teamActionAbsent: true, settingsCardAbsent: true, consoleErrors: [], pageErrors: [],
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
  for (const [label, mutate] of [
    ['R3 browser forged narrow geometry', value => { value.geometry.narrow.frame.collapsed = false }],
    ['R3 browser forged narrow visibility', value => { value.geometry.narrow.panelVisible = true }],
    ['R3 browser missing closed geometry', value => { delete value.geometry.closed }],
    ['R3 browser missing Tool handoff', value => { value.surfaces.toolHandoffKeptDetailsOpen = false }],
    ['R3 browser missing trigger close path', value => {
      value.keyboard = value.keyboard.filter(action => action !== 'trigger close')
    }],
    ['R3 browser missing populated member', value => { value.populated.initial.rosterCount = 0 }],
    ['R3 browser missing personal memory', value => { value.populated.initial.scopes = ['team'] }],
    ['R3 browser missing populated reload readback', value => { value.populated.reload.persistedReadback = false }],
    ['R3 browser missing Settings reload readback', value => { value.settings.reload.persistedReadback = false }],
    ['R3 browser populated fixture not seeded', value => { value.populated.fixture.mode = 'reused' }],
    ['R3 browser Settings locale not followed', value => { value.locale.settingsFollowedDsh = false }],
  ]) {
    const value = JSON.parse(activeContent.toString('utf8'))
    mutate(value)
    const content = `${JSON.stringify(value)}\n`
    await writeFile(activePath, content)
    activeRecord.bytes = Buffer.byteLength(content)
    activeRecord.sha256 = await sha256File(activePath)
    if ((await verifyP0Evidence(root, structuredClone(base), expected)).ok) {
      throw new Error(`${label} unexpectedly passed`)
    }
    cases.push([label])
  }
  await writeFile(activePath, activeContent)
  activeRecord.bytes = activeContent.length
  activeRecord.sha256 = await sha256File(activePath)
  const profileReloadPath = join(root, 'evidence/r3-browser-profile-reload.json')
  const profileReloadRecord = base.evidenceFiles.find(record => record.relativePath === 'evidence/r3-browser-profile-reload.json')
  const profileReloadContent = await readFile(profileReloadPath)
  const repairedReload = JSON.parse(profileReloadContent.toString('utf8'))
  repairedReload.representative.mode = 'seeded'
  const repairedReloadContent = `${JSON.stringify(repairedReload)}\n`
  await writeFile(profileReloadPath, repairedReloadContent)
  profileReloadRecord.bytes = Buffer.byteLength(repairedReloadContent)
  profileReloadRecord.sha256 = await sha256File(profileReloadPath)
  if ((await verifyP0Evidence(root, structuredClone(base), expected)).ok) {
    throw new Error('Profile reload repaired fixture unexpectedly passed')
  }
  cases.push(['Profile reload repaired fixture'])
  await writeFile(profileReloadPath, profileReloadContent)
  profileReloadRecord.bytes = profileReloadContent.length
  profileReloadRecord.sha256 = await sha256File(profileReloadPath)
  const r0Path = join(root, 'evidence/r3-browser-r0.json')
  const r0Record = base.evidenceFiles.find(record => record.relativePath === 'evidence/r3-browser-r0.json')
  const r0Content = await readFile(r0Path)
  const r0Base = JSON.parse(r0Content.toString('utf8'))
  for (const [label, mutate] of [
    ['R0 fallback nonempty body', value => { value.routeObserved.bodyBytes = 1 }],
    ['R0 fallback fake content-type', value => { value.routeObserved.contentType = 'application/json' }],
    ['R0 fallback fake owner', value => { value.routeOwner = 'dsh-agent-swarm' }],
    ['R0 fallback fake registration', value => { value.swarmRouteRegistered = true }],
    ['R0 Settings card still mounted', value => { value.settingsCardAbsent = false }],
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
  const removedPath = join(root, 'evidence/r3-browser-removed.json')
  const removedRecord = base.evidenceFiles.find(record => record.relativePath === 'evidence/r3-browser-removed.json')
  const removedContent = await readFile(removedPath)
  const removedMounted = JSON.parse(removedContent.toString('utf8'))
  removedMounted.settingsCardAbsent = false
  const removedMountedContent = `${JSON.stringify(removedMounted)}\n`
  await writeFile(removedPath, removedMountedContent)
  removedRecord.bytes = Buffer.byteLength(removedMountedContent)
  removedRecord.sha256 = await sha256File(removedPath)
  if ((await verifyP0Evidence(root, structuredClone(base), expected)).ok) {
    throw new Error('removed Settings card still mounted unexpectedly passed')
  }
  cases.push(['removed Settings card still mounted'])
  console.log(`P0 Bundle/evidence gates: Typert payload + 1 positive/2 negative response cases; 1 safe Bundle + 4 unsafe Bundle cases; positive evidence + ${cases.length} negative evidence cases: PASS`)
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
