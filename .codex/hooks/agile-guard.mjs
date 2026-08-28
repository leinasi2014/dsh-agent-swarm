#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ACTIVE_ALLOCATION_STATES = new Set(['OPENING', 'ACTIVE', 'CLOSING', 'UNKNOWN'])
const WRITER_CAPACITY = 2
const BROWSER_EXECUTABLES = new Set(['msedge', 'msedge.exe', 'chrome', 'chrome.exe', 'chromium', 'chromium.exe', 'firefox', 'firefox.exe'])
const PREVIEW_EXECUTABLES = new Set(['vite', 'vite.cmd', 'vite.exe', 'next', 'next.cmd', 'next.exe', 'http-server', 'http-server.cmd', 'serve', 'serve.cmd'])
const DELIVERY_CHECKPOINT = 'Mandatory delivery checkpoint: state (1) latest integrated user-visible or executable behavior, (2) accepted but unintegrated candidate, (3) how the next action changes behavior, a named decision, or a concrete blocker, and (4) the next observable acceptance event. Integrate accepted work before polishing more evidence.'
const FOUR_QUESTIONS = 'Before this edit, answer the mandatory delivery checkpoint: what behavior is integrated; what accepted work is unintegrated; does this edit change executable behavior, a named decision, or a concrete blocker; and what is the next observable acceptance event? This is a required reflection, not a machine classification of “over-design”.'

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasHookFields(value) {
  return isRecord(value) && ['hook_event_name', 'tool_name', 'tool_input', 'session_id', 'cwd'].some(key => Object.hasOwn(value, key))
}

export function unwrapHookInput(value) {
  if (!isRecord(value)) return {}
  if (hasHookFields(value)) return value
  for (const key of ['hookInput', 'hook_input', 'input', 'payload', 'data', 'params']) {
    if (hasHookFields(value[key])) return value[key]
  }
  return value
}

export function parseHookInput(text) {
  if (typeof text !== 'string' || text.trim() === '') return {}
  return unwrapHookInput(JSON.parse(text))
}

function hookContext(eventName, additionalContext) {
  return {
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext,
    },
  }
}

function blocked(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }
}

function warning(message) {
  return { systemMessage: `AGILE_GUARD_WARNING: ${message}` }
}

function commandFrom(input) {
  if (!isRecord(input.tool_input)) return ''
  return typeof input.tool_input.command === 'string' ? input.tool_input.command : ''
}

/**
 * Match the shell tool surface for the shell-command gates. Codex names the
 * shell tool variably across versions (legacy "Bash"; 0.147-era
 * "shell_command" / "shell_tool"). Accept those names, and fall back on the
 * command-payload structure so a renamed/unrecognised shell tool cannot
 * silently bypass the guard.
 */
function isShellCommandTool(toolName, input) {
  if (toolName === 'Bash' || toolName === 'shell_command' || toolName === 'shell_tool') return true
  return isRecord(input.tool_input) && typeof input.tool_input.command === 'string'
}

function splitCommand(command) {
  return command.split(/(?:&&|\|\||[;\r\n])/u).map(item => item.trim()).filter(Boolean)
}

function tokenize(command) {
  return command.match(/(?:"[^"]*"|'[^']*'|[^\s]+)/gu)?.map(token => token.replace(/^(?:"|')|(?:"|')$/gu, '')) ?? []
}

function isDirectCommand(tokens, names) {
  return names.has((tokens[0] ?? '').toLowerCase())
}

export function hasRawWorktreeLifecycle(command) {
  return splitCommand(command).some(segment => {
    const tokens = tokenize(segment)
    if (!isDirectCommand(tokens, new Set(['git', 'git.exe']))) return false
    const worktree = tokens.findIndex(token => token.toLowerCase() === 'worktree')
    return worktree >= 1 && new Set(['add', 'remove', 'move', 'prune']).has((tokens[worktree + 1] ?? '').toLowerCase())
  })
}

export function hasIsolationOpen(command) {
  return splitCommand(command).some(segment => {
    const tokens = tokenize(segment)
    if (!isDirectCommand(tokens, new Set(['pnpm', 'pnpm.cmd', 'pnpm.exe']))) return false
    const isolation = tokens.findIndex(token => token.toLowerCase() === 'isolation')
    if (isolation < 1) return false
    return (tokens[isolation + 1] ?? '').toLowerCase() === 'open'
  })
}

function runGit(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 1_500,
    windowsHide: true,
  }).trim()
}

export function discoverRepository(cwd) {
  if (typeof cwd !== 'string' || cwd === '') throw new Error('hook input has no cwd')
  const root = runGit(cwd, ['rev-parse', '--show-toplevel'])
  const commonDir = resolve(cwd, runGit(cwd, ['rev-parse', '--git-common-dir']))
  if (root === '') throw new Error('git did not return a repository root')
  return { root, commonDir }
}

export function readIsolationAuthority(repository) {
  const statePath = resolve(repository.commonDir, 'dsh-agent-swarm-isolation', 'v1', 'state.json')
  const state = JSON.parse(readFileSync(statePath, 'utf8'))
  if (!isRecord(state.allocations)) throw new Error('isolation authority has no allocations object')
  const allocations = Object.values(state.allocations)
  if (!allocations.every(isRecord)) throw new Error('isolation authority contains a malformed allocation')
  return {
    allocations,
    active: allocations.filter(allocation => ACTIVE_ALLOCATION_STATES.has(allocation.state)),
  }
}

function samePath(left, right) {
  return typeof left === 'string' && typeof right === 'string'
    && left.replaceAll('/', '\\').toLowerCase() === right.replaceAll('/', '\\').toLowerCase()
}

function isBrowserStart(command) {
  return splitCommand(command).some(segment => {
    const tokens = tokenize(segment)
    if (BROWSER_EXECUTABLES.has((tokens[0] ?? '').toLowerCase())) return true
    return (tokens[0] ?? '').toLowerCase() === 'start-process' && BROWSER_EXECUTABLES.has((tokens[1] ?? '').toLowerCase())
  })
}

function isPreviewStart(command) {
  return splitCommand(command).some(segment => {
    const tokens = tokenize(segment).map(token => token.toLowerCase())
    if (PREVIEW_EXECUTABLES.has(tokens[0] ?? '')) {
      return !['next', 'next.cmd', 'next.exe'].includes(tokens[0]) || tokens[1] === 'dev'
    }
    if (!new Set(['pnpm', 'pnpm.cmd', 'pnpm.exe', 'npm', 'npm.cmd', 'npm.exe']).has(tokens[0] ?? '')) return false
    const scripts = tokens.filter(token => token !== 'run' && token !== '--')
    return ['dev', 'preview'].includes(scripts[1] ?? '')
  })
}

function asArray(value) {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]
}

export function inspectTaskResources(repository) {
  if (process.platform !== 'win32') return { browsers: [], previews: [] }
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$root = [regex]::Escape($env:AGILE_GUARD_REPOSITORY_ROOT)',
    '$processes = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -match $root } | Select-Object ProcessId, Name, CommandLine)',
    '$listeners = @()',
    '$listenersAvailable = $true',
    'try { $listeners = @(Get-NetTCPConnection -State Listen | Select-Object OwningProcess, LocalPort) } catch { $listenersAvailable = $false }',
    '[pscustomobject]@{ processes = $processes; listeners = $listeners; listenersAvailable = $listenersAvailable } | ConvertTo-Json -Compress',
  ].join('; ')
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 1_500,
    windowsHide: true,
    env: { ...process.env, AGILE_GUARD_REPOSITORY_ROOT: repository.root },
  })
  const observed = JSON.parse(output)
  const processes = asArray(observed.processes).filter(isRecord)
  const listenerPids = new Set(asArray(observed.listeners).filter(isRecord).map(listener => Number(listener.OwningProcess)))
  const browsers = processes.filter(item => BROWSER_EXECUTABLES.has(String(item.Name ?? '').toLowerCase()))
  const previews = processes.filter(item => {
    const commandLine = String(item.CommandLine ?? '').toLowerCase()
    return listenerPids.has(Number(item.ProcessId))
      && /(?:vite|next(?:\.cmd)?\s+dev|webpack(?:-dev-server)?|http-server|\bserve\b)/u.test(commandLine)
  })
  return { browsers, previews, listenersAvailable: observed.listenersAvailable !== false }
}

function resourceSummary(resources) {
  const result = []
  if (resources.browsers.length > 0) result.push(`browser PID(s) ${resources.browsers.map(item => item.ProcessId).join(', ')}`)
  if (resources.previews.length > 0) result.push(`preview listener PID(s) ${resources.previews.map(item => item.ProcessId).join(', ')}`)
  return result
}

function preToolResult(input, dependencies) {
  const toolName = typeof input.tool_name === 'string' ? input.tool_name : ''
  const command = commandFrom(input)
  if (isShellCommandTool(toolName, input) && hasRawWorktreeLifecycle(command)) {
    return blocked('Raw git worktree add/remove/move/prune is forbidden. Use pnpm isolation open|status|close|reconcile.')
  }

  let repository
  const repositoryForInspection = () => {
    if (repository === undefined) repository = dependencies.discoverRepository(input.cwd)
    return repository
  }

  if (isShellCommandTool(toolName, input) && hasIsolationOpen(command)) {
    try {
      const authority = dependencies.readIsolationAuthority(repositoryForInspection())
      if (authority.active.length >= WRITER_CAPACITY) {
        return blocked(`Managed isolation already has ${authority.active.length} active or in-flight writer allocation(s); opening another lane would exceed the capacity of ${WRITER_CAPACITY}.`)
      }
    } catch (error) {
      return warning(`could not inspect the authoritative isolation ledger before open (${error.message}); Codex did not block the command.`)
    }
  }

  if (isShellCommandTool(toolName, input) && (isBrowserStart(command) || isPreviewStart(command))) {
    try {
      const resources = dependencies.inspectTaskResources(repositoryForInspection())
      const found = isBrowserStart(command) ? resources.browsers : resources.previews
      if (found.length > 0) {
        return blocked(`A task-owned ${isBrowserStart(command) ? 'verification browser' : 'preview listener'} is already running (${found.map(item => item.ProcessId).join(', ')}). Reuse it or finish its named validation before starting another.`)
      }
      if (resources.listenersAvailable === false && isPreviewStart(command)) {
        return warning('could not inspect Windows listening ports; Codex did not block the preview command.')
      }
    } catch (error) {
      return warning(`could not inspect task-owned browser/preview resources (${error.message}); Codex did not block the command.`)
    }
  }

  if (new Set(['apply_patch', 'Edit', 'Write']).has(toolName)) return hookContext('PreToolUse', FOUR_QUESTIONS)
  return {}
}

function stopResult(input, dependencies) {
  let repository
  try {
    repository = dependencies.discoverRepository(input.cwd)
  } catch (error) {
    return warning(`Stop could not discover the current repository (${error.message}); no process was stopped.`)
  }

  const report = []
  try {
    const authority = dependencies.readIsolationAuthority(repository)
    const lane = authority.active.find(allocation => samePath(allocation.path, repository.root))
    if (lane) report.push(`active unintegrated lane ${lane.id}#${lane.generation} (${lane.branch})`)
  } catch (error) {
    report.push(`isolation inspection warning: ${error.message}`)
  }

  try {
    const resources = dependencies.inspectTaskResources(repository)
    report.push(...resourceSummary(resources))
    if (resources.listenersAvailable === false) report.push('preview-port inspection unavailable')
  } catch (error) {
    report.push(`resource inspection warning: ${error.message}`)
  }

  if (report.length === 0) return {}
  return {
    systemMessage: `AGILE_GUARD Stop report: ${report.join('; ')}. No automatic cleanup: this guard owns no registered processes. DSH remains report-only while it has a named owner/purpose; P0 shutdown and port-free proof stay with the P0 scripts.`,
  }
}

export function evaluateHook(input, dependencies = {}) {
  const normalized = unwrapHookInput(input)
  const runtime = {
    discoverRepository,
    readIsolationAuthority,
    inspectTaskResources,
    ...dependencies,
  }
  switch (normalized.hook_event_name) {
    case 'SessionStart':
      return hookContext('SessionStart', DELIVERY_CHECKPOINT)
    case 'PreToolUse':
      return preToolResult(normalized, runtime)
    case 'Stop':
      return stopResult(normalized, runtime)
    default:
      return {}
  }
}

function main() {
  try {
    const chunks = []
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => chunks.push(chunk))
    process.stdin.on('end', () => {
      try {
        process.stdout.write(`${JSON.stringify(evaluateHook(parseHookInput(chunks.join(''))))}\n`)
      } catch (error) {
        process.stdout.write(`${JSON.stringify(warning(`hook inspection failed (${error.message}); Codex did not block the operation.`))}\n`)
      }
    })
  } catch (error) {
    process.stdout.write(`${JSON.stringify(warning(`hook initialization failed (${error.message}); Codex did not block the operation.`))}\n`)
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replaceAll('\\', '/')}`).href) main()
