import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { verifySafeBundlePatch } from './p0/bundle-shape.mjs'

const root = resolve(import.meta.dirname, '..')
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const failures = []

const bundle = await readFile(resolve(root, 'cordis.patch.yml'), 'utf8')
const bundleShape = verifySafeBundlePatch(bundle)
for (const failure of bundleShape.failures) failures.push(`bundle safety shape: ${failure}`)

for (const [label, relativePath] of [
  ['main', pkg.main],
  ['types', pkg.types],
  ['exports[.].default', pkg.exports?.['.']?.default],
  ['exports[.].types', pkg.exports?.['.']?.types],
  ['exports[./client].default', pkg.exports?.['./client']?.default],
  ['exports[./client].types', pkg.exports?.['./client']?.types],
  ['bundle patch', pkg.dsh?.bundle?.patch],
]) {
  if (typeof relativePath !== 'string') {
    failures.push(`${label}: missing path`)
    continue
  }
  try {
    await access(resolve(root, relativePath))
  } catch {
    failures.push(`${label}: target does not exist: ${relativePath}`)
  }
}

if (failures.length === 0) {
  const clientPath = resolve(root, pkg.exports['./client'].default)
  const clientSource = await readFile(clientPath, 'utf8')
  for (const forbidden of ['node:', 'dsh-storage', 'host-read-service', 'read-rpc-service']) {
    if (clientSource.includes(forbidden)) failures.push(`browser client imports forbidden Host/runtime surface: ${forbidden}`)
  }
  try {
    let registration
    runInNewContext(clientSource, {
      window: {
        __ModuleLoader__: {
          load(value) { registration = value },
        },
      },
    }, { filename: clientPath, timeout: 10_000 })
    if (registration?.id !== pkg.name || typeof registration?.factory !== 'function') {
      throw new Error('client bundle did not register its exact package id')
    }
    const requested = []
    const modules = {
      '@deepseek-ai/dsh-client-ui-primitives': {
        Button() {}, Pill() {}, StateDot() {}, IconUserOutline16() {}, IconCloseOutline16() {}, IconRefreshOutline16() {},
      },
      'react': { useId() {}, useSyncExternalStore() {} },
      'react/jsx-runtime': { jsx() {}, jsxs() {} },
    }
    const client = registration.factory((specifier) => {
      requested.push(specifier)
      if (!Object.hasOwn(modules, specifier)) throw new Error(`unexpected external ${specifier}`)
      return modules[specifier]
    })
    if (JSON.stringify(requested) !== JSON.stringify(Object.keys(modules))) {
      failures.push(`built browser client external request order/roster drifted: ${requested.join(', ')}`)
    }
    if (typeof client.SwarmReadClient !== 'function') failures.push('built browser client: missing SwarmReadClient')
    if (typeof client.TeamDashboardController !== 'function') failures.push('built browser client: missing TeamDashboardController')
    if (typeof client.apply !== 'function' || !Array.isArray(client.inject)) {
      failures.push('built browser client: missing Cordis client plugin face')
    }
    if (client.SWARM_READ_RPC_ENDPOINT !== '/swarm/v1') failures.push('built browser client: endpoint contract mismatch')
    for (const method of ['capabilities', 'teams', 'captainMembers', 'captainAnnouncements', 'captainDiagnostics', 'binding', 'status', 'snapshot', 'page']) {
      try {
        client.assertSwarmReadRpcValue(method, client.SWARM_READ_RPC_FIXTURES_V1.values[method])
      } catch (error) {
        failures.push(`built browser client rejects canonical ${method} server value: ${String(error)}`)
      }
    }
    const task = {
      id: 'task-packed', revision: 1, subject: 'Packed task', status: 'pending',
      blockedBy: [], priority: 1, createdAt: 1, updatedAt: 1,
    }
    const attempt = {
      id: 'attempt-packed', taskId: 'task-packed', generation: 1,
      phase: 'running', assignmentPhase: 'reserved', createdAt: 1, updatedAt: 1,
    }
    const interaction = {
      requestId: 'request-packed', intent: 'question', targetKind: 'captain',
      status: 'pending', createdAt: 1, updatedAt: 1,
    }
    for (const invalid of [
      { kind: 'tasks', entries: [attempt] },
      { kind: 'attempts', entries: [interaction] },
      { kind: 'pendingInteractions', entries: [task] },
      { kind: 'tasks', entries: [task, attempt] },
    ]) {
      try {
        client.assertSwarmReadRpcValue('page', {
          ...client.SWARM_READ_RPC_FIXTURES_V1.values.page,
          ...invalid,
          visibleTotal: invalid.entries.length,
          authoritativeTotal: invalid.entries.length,
        })
        failures.push(`built browser client accepted mismatched ${invalid.kind} page rows`)
      } catch {
        // Expected: the packed client keeps kind and row type coupled.
      }
    }
  } catch (error) {
    failures.push(`built browser client cannot be imported: ${String(error)}`)
  }
}

if (failures.length === 0) {
  const hostSource = await readFile(resolve(root, pkg.main), 'utf8')
  for (const required of [
    'agent_swarm_create_managed',
    'createWithDedicatedCaptain',
    'The caller stays outside the Team',
  ]) {
    if (!hostSource.includes(required)) failures.push(`built Host entry is stale: missing ${required}`)
  }

  try {
    const entry = await import(pathToFileURL(resolve(root, pkg.main)).href)
    if (typeof entry.apply !== 'function') failures.push('built entry: function plugin must export apply')
    if (typeof entry.name !== 'string') failures.push('built entry: function plugin must export name')
    if (typeof entry.AgentSwarmRuntime !== 'function') failures.push('built entry: missing AgentSwarmRuntime service export')
    if (typeof entry.TeamId !== 'function') failures.push('built entry: missing branded TeamId constructor')
  } catch (error) {
    failures.push(`built entry cannot be imported: ${String(error)}`)
  }
}

if (failures.length > 0) {
  console.error('Package artifact verification failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log('Package entry, browser client, types, bundle patch, and runtime imports: PASS')
}
