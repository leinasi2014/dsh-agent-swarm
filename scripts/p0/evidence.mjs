import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REQUIRED_P0_GATES = [
  'candidate-clean',
  'artifact-packed',
  'profile-add',
  'default-disabled',
  'dump-config',
  'boot-load',
  'service-tool-probe',
  'r2-read-rpc-handshake',
  'r3-browser-active',
  'r3-browser-r0',
  'r3-browser-removed',
  'unload',
  'reload',
  'r0-disable',
  'plugin-remove',
  'missing-storage-fail-closed',
  'official-clean',
  'resource-cleanup',
]

export const REQUIRED_P0_EVIDENCE_FILES = [
  'evidence/dump-config.log',
  'evidence/inventory-default-disabled.json',
  'evidence/inventory-explicit-enabled.json',
  'evidence/inventory-reload-enabled.json',
  'evidence/inventory-r0-disabled.json',
  'evidence/inventory-plugin-removed.json',
  'evidence/missing-storage-add.log',
  'evidence/missing-storage-boot.log',
  'evidence/profile-add.log',
  'evidence/profile-probe.jsonl',
  'evidence/profile-remove.log',
  'evidence/r2-binding.json',
  'evidence/r2-capabilities.json',
  'evidence/r2-fake-target.json',
  'evidence/r2-forged-origin.json',
  'evidence/r2-page-attempts.json',
  'evidence/r2-page-pendingInteractions.json',
  'evidence/r2-page-tasks.json',
  'evidence/r2-reload-binding.json',
  'evidence/r2-reload-session-create.json',
  'evidence/r2-session-create.json',
  'evidence/r2-snapshot.json',
  'evidence/r2-status.json',
  'evidence/r3-browser-active.json',
  'evidence/r3-browser-r0.json',
  'evidence/r3-browser-removed.json',
  'evidence/r3-r0-fail-closed.png',
  'evidence/r3-team-dashboard.png',
]

export const EXPECTED_P0_OFFICIAL_COMMIT = 'b150a551b8d465e31e418e1b2eaf5e79bbb7d28e'
export const EXPECTED_P0_OFFICIAL_TREE = '53915efe4e2126cc7779b73dfc8a3bcec5318c44'
const EXPECTED_SESSION_SELECTION_SOURCE = Object.freeze({
  relativePath: 'packages/client/runtime/src/client/sessions/service.ts',
  gitBlob: 'c66da4e0d3376d4d23f403d6651769fa53cee5fe',
  sha256: 'a4531ae9de0423400d3c641a5115a4a97b852276781a53fc2cfdbd4e34ba6b82',
})

const REQUIRED_P0_COMMANDS = new Map([
  ['cli-version', 0],
  ['candidate-build', 0],
  ['candidate-pack', 0],
  ['artifact-list', 0],
  ['profile-add', 0],
  ['dump-config', 0],
  ['profile-remove', 0],
  ['missing-storage-add', 0],
  ['missing-storage-boot', 1],
])

export async function sha256File(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

function inside(parent, child) {
  const rel = relative(resolve(parent), resolve(child))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

function requireString(value, label, failures) {
  if (typeof value !== 'string' || value.length === 0) failures.push(`${label} must be a non-empty string`)
}

function requireGitIdentity(value, label, failures) {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/u.test(value)) failures.push(`${label} must be a full lowercase Git object id`)
}

export async function verifyP0Evidence(root, manifest, expected = {}) {
  const failures = []
  if (manifest?.schemaVersion !== 1) failures.push('schemaVersion must be 1')
  if (manifest?.status !== 'pass') failures.push('status must be pass')

  requireGitIdentity(manifest?.candidate?.commit, 'candidate.commit', failures)
  requireGitIdentity(manifest?.candidate?.tree, 'candidate.tree', failures)
  requireGitIdentity(expected.candidateCommit, 'expected.candidateCommit', failures)
  requireGitIdentity(expected.candidateTree, 'expected.candidateTree', failures)
  if (manifest?.candidate?.commit !== expected.candidateCommit) failures.push('candidate commit does not match the trusted expected commit')
  if (manifest?.candidate?.tree !== expected.candidateTree) failures.push('candidate tree does not match the trusted expected tree')
  if (manifest?.candidate?.cleanBefore !== true || manifest?.candidate?.cleanAfter !== true) {
    failures.push('candidate must be clean before and after proof')
  }

  const artifactRel = manifest?.artifact?.relativePath
  requireString(artifactRel, 'artifact.relativePath', failures)
  requireString(manifest?.artifact?.sha256, 'artifact.sha256', failures)
  if (typeof artifactRel === 'string') {
    if (isAbsolute(artifactRel) || artifactRel.split(/[\\/]/).includes('..')) {
      failures.push('artifact.relativePath must stay inside the evidence root')
    } else {
      const artifactPath = resolve(root, artifactRel)
      const artifactStat = await stat(artifactPath).catch(() => undefined)
      if (artifactStat === undefined || !artifactStat.isFile()) {
        failures.push('artifact file is missing')
      } else {
        const digest = await sha256File(artifactPath)
        if (digest !== manifest.artifact.sha256) failures.push('artifact digest mismatch')
        if (artifactStat.size !== manifest.artifact.bytes) failures.push('artifact byte count mismatch')
      }
    }
  }

  const official = manifest?.official
  requireGitIdentity(official?.commitBefore, 'official.commitBefore', failures)
  requireGitIdentity(official?.treeBefore, 'official.treeBefore', failures)
  if (official?.commitBefore !== official?.commitAfter || official?.treeBefore !== official?.treeAfter) {
    failures.push('official identity changed during proof')
  }
  if (official?.commitBefore !== EXPECTED_P0_OFFICIAL_COMMIT || official?.commitAfter !== EXPECTED_P0_OFFICIAL_COMMIT) {
    failures.push('official commit does not match the fixed P0 baseline')
  }
  if (official?.treeBefore !== EXPECTED_P0_OFFICIAL_TREE || official?.treeAfter !== EXPECTED_P0_OFFICIAL_TREE) {
    failures.push('official tree does not match the fixed P0 baseline')
  }
  if (official?.statusBefore !== '' || official?.statusAfter !== '') failures.push('official checkout was not clean')
  if (official?.version !== '0.1.1-rc.2') failures.push('official CLI version must be 0.1.1-rc.2')

  const isolation = manifest?.isolation
  for (const key of ['runtimeRoot', 'dshHome', 'workspaceRoot', 'sandboxRoot', 'storageRoot', 'sessionRoot', 'probeModuleRoot']) {
    requireString(isolation?.[key], `isolation.${key}`, failures)
  }
  if (isolation !== undefined) {
    const roots = [isolation.dshHome, isolation.workspaceRoot, isolation.storageRoot, isolation.sessionRoot]
    if (roots.every(value => typeof value === 'string')) {
      if (new Set(roots.map(value => resolve(value).toLowerCase())).size !== roots.length) {
        failures.push('DSH_HOME, workspace, storage, and session roots must be distinct')
      }
      if (inside(isolation.workspaceRoot, isolation.storageRoot) || inside(isolation.storageRoot, isolation.workspaceRoot)) {
        failures.push('storage root overlaps workspace root')
      }
      if (inside(isolation.workspaceRoot, isolation.sessionRoot) || inside(isolation.sessionRoot, isolation.workspaceRoot)) {
        failures.push('session root overlaps workspace root')
      }
    }
    if (typeof isolation.defaultDshHome === 'string' && typeof isolation.dshHome === 'string'
      && resolve(isolation.defaultDshHome).toLowerCase() === resolve(isolation.dshHome).toLowerCase()) {
      failures.push('isolated DSH_HOME equals the user default home')
    }
    if (!Array.isArray(isolation.probeModuleUrls) || isolation.probeModuleUrls.length !== 2) {
      failures.push('isolation.probeModuleUrls must contain the two file URLs')
    } else {
      for (const value of isolation.probeModuleUrls) {
        try {
          const path = fileURLToPath(value)
          if (!inside(isolation.runtimeRoot, path)) failures.push('probe module URL escapes runtime root')
          if (!/[\s]/u.test(path) || !/[^\x00-\x7F]/u.test(path)) failures.push('probe module URL path must exercise whitespace and non-ASCII decoding')
        } catch {
          failures.push('probe module URL must be a valid file URL')
        }
      }
    }
  }

  const gates = new Map((manifest?.gates ?? []).map(gate => [gate.name, gate]))
  for (const name of REQUIRED_P0_GATES) {
    if (gates.get(name)?.status !== 'pass') failures.push(`required gate did not pass: ${name}`)
  }
  const commands = manifest?.commands
  if (!Array.isArray(commands)) {
    failures.push('commands must be an array')
  } else {
    for (const [name, expectedExitCode] of REQUIRED_P0_COMMANDS) {
      const matches = commands.filter(command => command?.name === name)
      if (matches.length !== 1) {
        failures.push(`required command must appear exactly once: ${name}`)
        continue
      }
      if (matches[0].timedOut === true) failures.push(`required command timed out: ${name}`)
      if (matches[0].exitCode !== expectedExitCode) failures.push(`required command exit code mismatch: ${name}`)
    }
  }
  if (manifest?.cleanup?.runtimeRemoved !== true || manifest?.cleanup?.portFree !== true) {
    failures.push('runtime resources were not fully cleaned')
  }
  if (manifest?.cleanup?.artifactRetained !== true || manifest?.cleanup?.evidenceRetained !== true) {
    failures.push('immutable artifact and evidence must be retained')
  }

  const evidenceFiles = manifest?.evidenceFiles
  if (!Array.isArray(evidenceFiles)) {
    failures.push('evidenceFiles must be an array')
  } else {
    const byPath = new Map()
    for (const record of evidenceFiles) {
      const relativePath = record?.relativePath
      requireString(relativePath, 'evidenceFiles.relativePath', failures)
      if (typeof relativePath !== 'string') continue
      if (byPath.has(relativePath)) failures.push(`evidence file record is duplicated: ${relativePath}`)
      byPath.set(relativePath, record)
      if (isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes('..') || !relativePath.startsWith('evidence/')) {
        failures.push(`evidence file path must stay inside evidence/: ${relativePath}`)
        continue
      }
      const evidencePath = resolve(root, relativePath)
      const evidenceStat = await stat(evidencePath).catch(() => undefined)
      if (evidenceStat === undefined || !evidenceStat.isFile()) {
        failures.push(`evidence file is missing: ${relativePath}`)
        continue
      }
      if (!Number.isSafeInteger(record.bytes) || record.bytes < 0 || evidenceStat.size !== record.bytes) {
        failures.push(`evidence file byte count mismatch: ${relativePath}`)
      }
      if (typeof record.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(record.sha256)
        || await sha256File(evidencePath) !== record.sha256) {
        failures.push(`evidence file digest mismatch: ${relativePath}`)
      }
    }
    for (const relativePath of REQUIRED_P0_EVIDENCE_FILES) {
      if (!byPath.has(relativePath)) failures.push(`required decision evidence is not declared: ${relativePath}`)
    }
    if (evidenceFiles.length !== REQUIRED_P0_EVIDENCE_FILES.length) {
      failures.push('evidenceFiles must contain exactly the required decision evidence set')
    }
  }
  await verifyR3BrowserEvidence(root, failures)
  return { ok: failures.length === 0, failures }
}

async function verifyR3BrowserEvidence(root, failures) {
  const readJson = async (relativePath) => {
    try { return JSON.parse(await readFile(resolve(root, relativePath), 'utf8')) } catch {
      failures.push(`R3 browser evidence is not valid JSON: ${relativePath}`)
      return undefined
    }
  }
  const active = await readJson('evidence/r3-browser-active.json')
  verifyBootstrap(active?.bootstrap, active?.rootSessionId, true, 'active', failures)
  verifyTestingNotice(active, 'active', failures)
  verifyApiKeyOnboarding(active, 'active', failures)
  const browserIdentity = active?.browser
  if (browserIdentity?.engine !== 'chromium' || !isAbsolute(browserIdentity?.executablePath ?? '')
    || typeof browserIdentity?.version !== 'string' || browserIdentity.version.length === 0) {
    failures.push('R3 active browser evidence must record the Chromium executable locator and version')
  }
  if (active?.status !== 'pass' || active?.handoff?.officialSessionSelected !== true
    || active?.handoff?.chatTextboxVisible !== true || active?.reload !== true
    || typeof active?.rootSessionId !== 'string' || typeof active?.teamId !== 'string'
    || !Array.isArray(active?.keyboard) || active.keyboard.length < 5) {
    failures.push('R3 active browser evidence does not prove render/keyboard/handoff/reload')
  }
  if (active?.handoff?.officialSelectionSource !== 'localStorage:dsh.sessions.current'
    || active?.handoff?.currentSessionId !== active?.rootSessionId
    || active?.handoff?.reloadedSessionId !== active?.rootSessionId) {
    failures.push('R3 Captain handoff is not bound to the exact official root Session selection')
  }
  if (!Array.isArray(active?.consoleErrors) || active.consoleErrors.length !== 0
    || !Array.isArray(active?.pageErrors) || active.pageErrors.length !== 0) {
    failures.push('R3 active browser contains an unclassified console or page error')
  }
  const requests = active?.requests
  const allowed = new Set(['capabilities', 'binding', 'status', 'snapshot', 'page'])
  if (!Array.isArray(requests) || requests.length === 0 || requests.some(
    request => request?.method !== 'POST' || !allowed.has(request?.body?.method),
  )) failures.push('R3 active browser evidence contains no read requests or a non-read request')

  const r0 = await readJson('evidence/r3-browser-r0.json')
  verifyBootstrap(r0?.bootstrap, active?.rootSessionId, false, 'R0', failures)
  verifyTestingNotice(r0, 'R0', failures)
  verifyApiKeyOnboarding(r0, 'R0', failures)
  if (JSON.stringify(r0?.browser) !== JSON.stringify(browserIdentity)) {
    failures.push('R3 R0 browser identity differs from the active proof')
  }
  if (r0?.status !== 'pass' || r0?.routeUnavailable !== true || r0?.renderedData !== false) {
    failures.push('R3 R0 browser evidence does not prove fail-closed no-data rendering')
  }
  if (!Array.isArray(r0?.consoleErrors) || r0.consoleErrors.length !== 0
    || !Array.isArray(r0?.pageErrors) || r0.pageErrors.length !== 0) {
    failures.push('R3 R0 browser contains an unclassified console or page error')
  }
  const removed = await readJson('evidence/r3-browser-removed.json')
  verifyBootstrap(removed?.bootstrap, active?.rootSessionId, false, 'removed', failures)
  verifyTestingNotice(removed, 'removed', failures)
  verifyApiKeyOnboarding(removed, 'removed', failures)
  if (JSON.stringify(removed?.browser) !== JSON.stringify(browserIdentity)) {
    failures.push('R3 removed browser identity differs from the active proof')
  }
  if (removed?.status !== 'pass' || removed?.teamActionAbsent !== true) {
    failures.push('R3 removed browser evidence does not prove client action disposal')
  }
  if (!Array.isArray(removed?.consoleErrors) || removed.consoleErrors.length !== 0
    || !Array.isArray(removed?.pageErrors) || removed.pageErrors.length !== 0) {
    failures.push('R3 removed browser contains an unclassified console or page error')
  }
  for (const relativePath of ['evidence/r3-team-dashboard.png', 'evidence/r3-r0-fail-closed.png']) {
    const screenshot = await stat(resolve(root, relativePath)).catch(() => undefined)
    if (screenshot === undefined || !screenshot.isFile() || screenshot.size < 1_024) {
      failures.push(`R3 browser screenshot is missing or implausibly small: ${relativePath}`)
    }
  }
}

function verifyBootstrap(value, rootSessionId, requireFrameworkTarget, label, failures) {
  if (value?.key !== 'dsh.sessions.current' || value?.value?.sessionId !== rootSessionId
    || value?.purpose !== 'isolated-proof-initial-ui-selection' || value?.authority !== false
    || JSON.stringify(value?.officialSource) !== JSON.stringify(EXPECTED_SESSION_SELECTION_SOURCE)
    || (requireFrameworkTarget && value?.frameworkTargetObserved !== true)) {
    failures.push(`R3 ${label} browser bootstrap is not bound to the pinned official Session selection seam`)
  }
}

function verifyTestingNotice(value, label, failures) {
  if (typeof value?.officialTestingNoticePresent !== 'boolean'
    || typeof value?.officialTestingNoticeDismissed !== 'boolean'
    || (value.officialTestingNoticePresent && !value.officialTestingNoticeDismissed)) {
    failures.push(`R3 ${label} browser did not handle the official testing notice through its accessible action`)
  }
}

function verifyApiKeyOnboarding(value, label, failures) {
  if (typeof value?.officialApiKeyOnboardingPresent !== 'boolean'
    || typeof value?.officialApiKeyOnboardingSkipped !== 'boolean'
    || (value.officialApiKeyOnboardingPresent && !value.officialApiKeyOnboardingSkipped)) {
    failures.push(`R3 ${label} browser did not skip the official API-key onboarding through Configure later`)
  }
}
