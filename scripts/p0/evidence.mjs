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
  'unload',
  'reload',
  'r0-disable',
  'plugin-remove',
  'missing-storage-fail-closed',
  'official-clean',
  'resource-cleanup',
]

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

export async function verifyP0Evidence(root, manifest) {
  const failures = []
  if (manifest?.schemaVersion !== 1) failures.push('schemaVersion must be 1')
  if (manifest?.status !== 'pass') failures.push('status must be pass')

  requireString(manifest?.candidate?.commit, 'candidate.commit', failures)
  requireString(manifest?.candidate?.tree, 'candidate.tree', failures)
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
  requireString(official?.commitBefore, 'official.commitBefore', failures)
  requireString(official?.treeBefore, 'official.treeBefore', failures)
  if (official?.commitBefore !== official?.commitAfter || official?.treeBefore !== official?.treeAfter) {
    failures.push('official identity changed during proof')
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
  if (manifest?.cleanup?.runtimeRemoved !== true || manifest?.cleanup?.portFree !== true) {
    failures.push('runtime resources were not fully cleaned')
  }
  if (manifest?.cleanup?.artifactRetained !== true || manifest?.cleanup?.evidenceRetained !== true) {
    failures.push('immutable artifact and evidence must be retained')
  }
  return { ok: failures.length === 0, failures }
}
