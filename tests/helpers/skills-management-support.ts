/**
 * Shared read-back helpers for the S1 skills-management spec family.
 *
 * The manager-side counterexamples are split by responsibility across four
 * spec files (core processing / authorization fences / session durability /
 * batch acknowledgement); this module holds ONLY durable-medium read-back
 * and sandbox tracking so every spec asserts against the SAME official
 * records, never a mirrored in-memory copy.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, vi } from 'vitest'
import { AgentSwarmRuntime } from '../../src/runtime/orchestrator-runtime.js'
import { skillsConsumerKey, skillsRequestKey } from '../../src/storage/skills-management.js'
import { skillsUnitFile } from './skills-management-composition.js'

export interface UnitRow { [field: string]: unknown }

export interface ConsumerRow extends UnitRow {
  cursorSequence: number
  needsResync: boolean
  pendingBatch?: { batchId: string; refs: { sequence: number; id: string; kind: string }[] }
  lastAck?: { batchId: string; outcome: string; refs: { sequence: number; id: string }[] }
  anchors?: { sequence: number; id: string }[]
  anchorsDropped?: number
  conflicts?: { sequence: number; expectedEventId: string; actualEventId: string }[]
}

/** Track temp sandboxes and remove them all after the spec file finishes. */
export function skillsSandboxTracker(prefix: string): { freshSandbox: () => Promise<string> } {
  const dirs: string[] = []
  afterAll(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true })
  })
  return {
    freshSandbox: async () => {
      const sandbox = await mkdtemp(join(tmpdir(), prefix))
      dirs.push(sandbox)
      return sandbox
    },
  }
}

/** Read the exact official request row back from the durable unit medium. */
export async function readRow(sandbox: string, scope: string, teamId: string, requestId: string): Promise<UnitRow | undefined> {
  const unit = JSON.parse(await readFile(skillsUnitFile(sandbox), 'utf8')) as { tables: { requests: Record<string, UnitRow | undefined> } }
  return unit.tables.requests[skillsRequestKey(scope, teamId, requestId)]
}

/** Read the exact official consumer row back from the durable unit medium. */
export async function readConsumerRow(sandbox: string, scope: string, teamId: string): Promise<ConsumerRow | undefined> {
  const unit = JSON.parse(await readFile(skillsUnitFile(sandbox), 'utf8')) as { tables: { consumers: Record<string, ConsumerRow | undefined> } }
  return unit.tables.consumers[skillsConsumerKey(scope, teamId)]
}

export function toolNames(tools: { name: string }[] | undefined): string[] {
  return (tools ?? []).map(tool => tool.name)
}

export function failureFields(outcome: { code?: string; error?: string }): string {
  return [outcome.code ?? '', outcome.error ?? ''].join(' ')
}

export const REQUEST_TOOL = 'agent_swarm_skills_request'
export const STATUS_TOOL = 'agent_swarm_skills_status'

/**
 * Controlled ENTERED/RELEASED barrier on the REAL official source read
 * (`AgentSwarmRuntime.prototype.listTeamAggregates`, dynamically called by
 * the Skills plugin — the same wrapping pattern the repository already uses
 * in startup-recovery-exclusion.spec). The wrapper performs the GENUINE read
 * (awaits the original implementation), then pauses the CALLER strictly
 * between the real IO returning and the Skills module resuming — the exact
 * post-IO window the authorization fences must survive at the official
 * commit boundaries. One target scope, one arm (arm lazily so unrelated
 * internal reads never consume the barrier); entry is explicitly notified;
 * `restore()` releases the gate and puts the prototype back. No private
 * queues, no request-state edits, no Host source changes. `pauseOn` names
 * WHICH matching read pauses (1st activity snapshot, 2nd evidence read …);
 * earlier matching reads pass through untouched and still perform the real
 * read. One arm total.
 */
export interface SkillsReadBarrier {
  /** Resolves once the target read RETURNED and the caller is paused inside. */
  readonly entered: Promise<void>
  /** Start listening (one-shot). Call right before the measured Skills operation. */
  arm: () => void
  /** Let the paused caller continue. Idempotent. */
  release: () => void
  /** Release, restore the original prototype method, and disarm. Always paired in `finally`. */
  restore: () => void
}

export function installSkillsSourceReadBarrier(targetScope: string, pauseOn = 1): SkillsReadBarrier {
  const original = AgentSwarmRuntime.prototype.listTeamAggregates
  let armed = false
  let released = false
  let matches = 0
  let markEntered!: () => void
  const entered = new Promise<void>(resolve => { markEntered = resolve })
  let openGate!: () => void
  const gate = new Promise<void>(resolve => { openGate = resolve })
  const spy = vi.spyOn(AgentSwarmRuntime.prototype, 'listTeamAggregates').mockImplementation(
    async function (this: AgentSwarmRuntime, scope) {
      const teams = await original.call(this, scope)
      if (armed && String(scope) === targetScope) {
        matches += 1
        if (matches === pauseOn) {
          armed = false
          markEntered()
          if (!released) await gate
        }
      }
      return teams
    },
  )
  const release = (): void => { released = true; openGate() }
  return {
    entered,
    arm: () => { armed = true },
    release,
    restore: () => {
      release()
      spy.mockRestore()
    },
  }
}
