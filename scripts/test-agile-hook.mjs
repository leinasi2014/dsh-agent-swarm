import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { evaluateHook, parseHookInput } from '../.codex/hooks/agile-guard.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const hook = fileURLToPath(new URL('../.codex/hooks/agile-guard.mjs', import.meta.url))

function expect(condition, message) {
  if (!condition) throw new Error(message)
}

function fixture(overrides = {}) {
  return {
    hook_event_name: 'PreToolUse',
    cwd: 'D:\\repo',
    tool_name: 'Bash',
    tool_input: { command: 'git status --short' },
    ...overrides,
  }
}

function runtime(overrides = {}) {
  return {
    discoverRepository: cwd => ({ root: cwd, commonDir: `${cwd}\\.git` }),
    readIsolationAuthority: () => ({ allocations: [], active: [] }),
    readDeliveryFlowPolicy: () => ({ circuitBreakerActive: true }),
    inspectTaskResources: () => ({ browsers: [], previews: [], listenersAvailable: true }),
    ...overrides,
  }
}

function denied(result) {
  return result?.hookSpecificOutput?.permissionDecision === 'deny'
}

function additionalContext(result) {
  return result?.hookSpecificOutput?.additionalContext ?? ''
}

const configuration = JSON.parse(readFileSync(new URL('../.codex/hooks.json', import.meta.url), 'utf8'))
for (const event of ['SessionStart', 'PreToolUse', 'Stop']) {
  expect(Array.isArray(configuration.hooks?.[event]), `hooks.json must configure ${event}`)
  const handler = configuration.hooks[event][0]?.hooks?.[0]
  expect(handler?.type === 'command' && typeof handler.commandWindows === 'string', `${event} needs a Windows command hook`)
  expect(handler.commandWindows.includes('agile-guard.mjs'), `${event} must invoke agile-guard.mjs`)
}
expect(configuration.hooks.PreToolUse[0].matcher === '.*', 'PreToolUse must observe all local tools')

const start = evaluateHook({ hook_event_name: 'SessionStart', cwd: 'D:\\repo' })
expect(additionalContext(start).includes('Mandatory delivery checkpoint'), 'SessionStart must provide delivery context')

const rawLifecycle = evaluateHook(fixture({ tool_input: { command: 'git -C D:\\repo worktree add D:\\repo\\lane -b codex/lane' } }), runtime())
expect(denied(rawLifecycle), 'raw git worktree lifecycle must be denied')

const harmlessGit = evaluateHook(fixture({ tool_input: { command: "Write-Output 'git worktree add is forbidden'" } }), runtime())
expect(!denied(harmlessGit), 'quoted documentation text must not be denied as a lifecycle command')

const listWorktrees = evaluateHook(fixture({ tool_input: { command: 'git worktree list' } }), runtime())
expect(!denied(listWorktrees), 'git worktree list must remain allowed')

const capacity = evaluateHook(fixture({ tool_input: { command: 'pnpm isolation open --id third --branch codex/third --owner test' } }), runtime({
  readIsolationAuthority: () => ({ active: [{ state: 'ACTIVE' }, { state: 'ACTIVE' }] }),
}))
expect(denied(capacity), 'an isolation open above the two-writer cap must be denied')

const capacityAvailable = evaluateHook(fixture({ tool_input: { command: 'pnpm isolation open --id second --branch codex/second --owner test' } }), runtime({
  readIsolationAuthority: () => ({ active: [{ state: 'ACTIVE' }] }),
}))
expect(!denied(capacityAvailable), 'an isolation open below capacity must remain allowed')

const ledgerWarning = evaluateHook(fixture({ tool_input: { command: 'pnpm isolation open --id check --branch codex/check --owner test' } }), runtime({
  readIsolationAuthority: () => { throw new Error('ledger unavailable') },
}))
expect(!denied(ledgerWarning) && ledgerWarning.systemMessage?.includes('did not block'), 'ledger inspection failure must warn without denying')

const browserReuse = evaluateHook(fixture({ tool_input: { command: 'Start-Process msedge.exe -- --user-data-dir=D:\\repo\\profile' } }), runtime({
  inspectTaskResources: () => ({ browsers: [{ ProcessId: 42 }], previews: [], listenersAvailable: true }),
}))
expect(denied(browserReuse), 'a second task-owned browser launch must be denied')

const previewReuse = evaluateHook(fixture({ tool_input: { command: 'pnpm dev -- --port 4173' } }), runtime({
  inspectTaskResources: () => ({ browsers: [], previews: [{ ProcessId: 43 }], listenersAvailable: true }),
}))
expect(denied(previewReuse), 'a second task-owned preview launch must be denied')

const noResource = evaluateHook(fixture({ tool_input: { command: 'pnpm dev -- --port 4173' } }), runtime())
expect(!denied(noResource), 'a preview launch with no owned listener must remain allowed')

// Codex 0.147 names the shell tool shell_command / shell_tool instead of the
// legacy "Bash"; each deny-scenario must still gate under those names, and a
// renamed-but-structurally-identical shell tool must fall back by payload.
const shellRawLifecycle = evaluateHook(fixture({ tool_name: 'shell_command', tool_input: { command: 'git -C D:\\repo worktree add D:\\repo\\lane -b codex/lane' } }), runtime())
expect(denied(shellRawLifecycle), 'shell_command raw git worktree lifecycle must be denied')

const shellToolRawLifecycle = evaluateHook(fixture({ tool_name: 'shell_tool', tool_input: { command: 'git -C D:\\repo worktree remove D:\\repo\\lane' } }), runtime())
expect(denied(shellToolRawLifecycle), 'shell_tool raw git worktree lifecycle must be denied')

const shellCapacity = evaluateHook(fixture({ tool_name: 'shell_command', tool_input: { command: 'pnpm isolation open --id third --branch codex/third --owner test' } }), runtime({
  readIsolationAuthority: () => ({ active: [{ state: 'ACTIVE' }, { state: 'ACTIVE' }] }),
}))
expect(denied(shellCapacity), 'shell_command isolation open above the two-writer cap must be denied')

const shellBrowser = evaluateHook(fixture({ tool_name: 'shell_tool', tool_input: { command: 'Start-Process msedge.exe -- --user-data-dir=D:\\repo\\profile' } }), runtime({
  inspectTaskResources: () => ({ browsers: [{ ProcessId: 44 }], previews: [], listenersAvailable: true }),
}))
expect(denied(shellBrowser), 'shell_tool browser relaunch must be denied')

const renamedShellFallback = evaluateHook(fixture({ tool_name: 'Terminal', tool_input: { command: 'git -C D:\\repo worktree add D:\\repo\\lane -b codex/lane' } }), runtime())
expect(denied(renamedShellFallback), 'an unrecognised shell tool name must still deny raw worktree lifecycle via command-structure fallback')

const editContext = evaluateHook(fixture({ tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch' } }), runtime())
expect(additionalContext(editContext).includes('not a machine classification'), 'edits must receive reflection context without a subjective denial')
expect(!denied(editContext), 'reflection context must not deny an edit')

const newReceipt = evaluateHook(fixture({
  tool_name: 'apply_patch',
  tool_input: { patch: '*** Begin Patch\n*** Add File: scripts/runtime-evidence-receipt.mjs\n+export {}\n*** End Patch' },
}), runtime())
expect(denied(newReceipt), 'active circuit breaker must deny a new evidence/receipt support artifact')

const newDesign = evaluateHook(fixture({
  tool_name: 'apply_patch',
  tool_input: { patch: '*** Begin Patch\n*** Add File: docs/development/next-ui-design.md\n+# More design\n*** End Patch' },
}), runtime())
expect(denied(newDesign), 'active circuit breaker must deny a new development/design document')

const productFile = evaluateHook(fixture({
  tool_name: 'apply_patch',
  tool_input: { patch: '*** Begin Patch\n*** Add File: src/client/VisibleTeamPanel.tsx\n+export {}\n*** End Patch' },
}), runtime())
expect(!denied(productFile), 'circuit breaker must allow product implementation')

const existingAuthority = evaluateHook(fixture({
  tool_name: 'apply_patch',
  tool_input: { patch: '*** Begin Patch\n*** Update File: docs/governance/project-binding.yaml\n@@\n-old\n+new\n*** End Patch' },
}), runtime())
expect(!denied(existingAuthority), 'circuit breaker must allow editing an existing minimum authority')

const samePatchBypass = evaluateHook(fixture({
  tool_name: 'apply_patch',
  tool_input: { patch: '*** Begin Patch\n*** Add File: docs/adr/9999-new.md\n+decision\n*** Update File: docs/governance/project-binding.yaml\n+  executableOutcomeCircuitBreaker: inactive\n*** End Patch' },
}), runtime())
expect(denied(samePatchBypass), 'a same-patch policy edit must not bypass the active circuit breaker')

const policyUnavailable = evaluateHook(fixture({
  tool_name: 'Write',
  tool_input: { file_path: 'scripts/new-evidence-oracle.mjs', content: 'export {}' },
}), runtime({ readDeliveryFlowPolicy: () => { throw new Error('binding unavailable') } }))
expect(denied(policyUnavailable), 'new support artifacts must fail closed when policy cannot be read')

const stop = evaluateHook({ hook_event_name: 'Stop', cwd: 'D:\\repo' }, runtime({
  readIsolationAuthority: () => ({ active: [{ id: 'lane', generation: 1, branch: 'codex/lane', path: 'D:\\repo', state: 'ACTIVE' }] }),
  inspectTaskResources: () => ({ browsers: [{ ProcessId: 50 }], previews: [{ ProcessId: 51 }], listenersAvailable: true }),
}))
expect(stop.systemMessage?.includes('active unintegrated lane lane#1'), 'Stop must report the current active lane')
expect(stop.systemMessage?.includes('No automatic cleanup'), 'Stop must not kill unregistered processes')

for (const envelope of ['hookInput', 'hook_input', 'input', 'payload', 'data', 'params']) {
  const enveloped = parseHookInput(JSON.stringify({ [envelope]: { hook_event_name: 'SessionStart', cwd: 'D:\\repo' } }))
  expect(enveloped.hook_event_name === 'SessionStart', `${envelope} envelope must be accepted`)
}
const direct = spawnSync(process.execPath, [hook], {
  input: JSON.stringify({ input: { hook_event_name: 'SessionStart', cwd: root } }),
  encoding: 'utf8',
  windowsHide: true,
})
expect(direct.status === 0, `hook CLI fixture failed: ${direct.stderr}`)
expect(JSON.parse(direct.stdout).hookSpecificOutput?.hookEventName === 'SessionStart', 'hook CLI must emit Codex-compatible JSON')

console.log('agile hook fixtures: PASS')
