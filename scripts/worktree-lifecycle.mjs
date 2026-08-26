#!/usr/bin/env node
import {
  LifecycleError,
  assertLifecycleCliSource,
  closeAllocation,
  openAllocation,
  recoverAuthorityLock,
  reconcileAllocations,
  statusReport,
} from './worktree-lifecycle-core.mjs'

function parse(argv) {
  const [command, ...rest] = argv
  const options = { command }
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]
    if (!token.startsWith('--')) throw new LifecycleError('INVALID_ARGUMENT', `unexpected argument: ${token}`)
    const key = token.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())
    if (Object.hasOwn(options, key)) throw new LifecycleError('INVALID_ARGUMENT', `duplicate option: ${token}`)
    if (key === 'json' || key === 'repair' || key === 'recoverLock') {
      options[key] = true
      continue
    }
    const value = rest[index + 1]
    if (value === undefined || value.startsWith('--')) throw new LifecycleError('INVALID_ARGUMENT', `missing value for ${token}`)
    options[key] = value
    index += 1
  }
  const allowed = {
    open: new Set(['command', 'id', 'branch', 'base', 'owner', 'json']),
    status: new Set(['command', 'json']),
    close: new Set(['command', 'id', 'generation', 'owner', 'outcome', 'archiveRef', 'json']),
    reconcile: new Set(['command', 'repair', 'recoverLock', 'json']),
    help: new Set(['command']),
    '--help': new Set(['command']),
  }[command]
  if (allowed) {
    const unknown = Object.keys(options).find(key => !allowed.has(key))
    if (unknown) throw new LifecycleError('INVALID_ARGUMENT', `unknown option: --${unknown.replace(/[A-Z]/gu, letter => `-${letter.toLowerCase()}`)}`)
  }
  return options
}

function required(options, key) {
  if (typeof options[key] !== 'string' || options[key] === '') throw new LifecycleError('INVALID_ARGUMENT', `--${key.replace(/[A-Z]/gu, letter => `-${letter.toLowerCase()}`)} is required`)
  return options[key]
}

function usage() {
  return `Project-owned Git isolation lifecycle

Usage:
  pnpm isolation open --id <slug> --branch <branch> --owner <id> [--base <sha>] [--json]
  pnpm isolation status [--json]
  pnpm isolation close --id <slug> --generation <n> --owner <id> --outcome <integrated|archived> [--archive-ref <ref>] [--json]
  pnpm isolation reconcile [--repair] [--recover-lock] [--json]

Raw git worktree add/remove/move/prune commands are forbidden for development lanes.
The authority ledger lives under the repository Git common directory, not in committed Markdown.`
}

function print(value, json) {
  if (json) {
    console.log(JSON.stringify(value, null, 2))
    return
  }
  if (Array.isArray(value?.allocations)) {
    console.log(`Isolation status: ${value.healthy ? 'PASS' : 'FAIL'}; ${value.allocations.filter(item => item.state === 'ACTIVE').length} active allocation(s); revision ${value.revision}`)
    for (const failure of value.failures) console.log(`- ${failure}`)
    return
  }
  if (Array.isArray(value?.actions)) {
    console.log(`Reconcile: ${value.actions.length} action(s)${value.state ? `; revision ${value.state.revision}` : ''}`)
    for (const action of value.actions) console.log(`- ${action.id}: ${action.from} -> ${action.to}${action.unsafe ? ' (unsafe)' : ''}`)
    return
  }
  if (typeof value?.recovered === 'boolean') {
    console.log(`Lock recovery: ${value.recovered ? 'recovered' : value.reason}`)
    return
  }
  console.log(`${value.id}: ${value.state} generation=${value.generation} branch=${value.branch}`)
}

try {
  const options = parse(process.argv.slice(2))
  if (['open', 'close'].includes(options.command) || (options.command === 'reconcile' && (options.repair || options.recoverLock))) {
    assertLifecycleCliSource({ cwd: process.cwd(), sourceUrl: import.meta.url })
  }
  let result
  switch (options.command) {
    case 'open':
      result = openAllocation({
        cwd: process.cwd(),
        id: required(options, 'id'),
        branch: required(options, 'branch'),
        base: options.base,
        owner: required(options, 'owner'),
      })
      break
    case 'status':
      result = statusReport({ cwd: process.cwd() })
      if (!result.healthy) process.exitCode = 1
      break
    case 'close':
      result = closeAllocation({
        cwd: process.cwd(),
        id: required(options, 'id'),
        generation: required(options, 'generation'),
        owner: required(options, 'owner'),
        outcome: required(options, 'outcome'),
        archiveRef: options.archiveRef,
      })
      break
    case 'reconcile':
      if (options.recoverLock === true && options.repair === true) throw new LifecycleError('INVALID_ARGUMENT', '--repair and --recover-lock are separate operations')
      result = options.recoverLock === true
        ? recoverAuthorityLock({ cwd: process.cwd() })
        : reconcileAllocations({ cwd: process.cwd(), repair: options.repair === true })
      if (Array.isArray(result.actions) && result.actions.some(action => action.unsafe === true)) process.exitCode = 1
      break
    case 'help':
    case '--help':
    case undefined:
      console.log(usage())
      process.exitCode = options.command === undefined ? 1 : 0
      break
    default:
      throw new LifecycleError('INVALID_ARGUMENT', `unknown command: ${options.command}`)
  }
  if (result !== undefined) print(result, options.json === true)
} catch (error) {
  const code = error instanceof LifecycleError ? error.code : 'UNEXPECTED'
  console.error(`${code}: ${error.message}`)
  process.exitCode = 1
}
