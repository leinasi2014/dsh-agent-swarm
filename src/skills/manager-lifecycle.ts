/**
 * Dedicated manager Session lifecycle (structure split, behavior-identical):
 * the durable binding identity, resume-first open through the official
 * `agents.resume`/`agents.create` pair with setup-commit + post-return
 * generation re-checks (a late handle is never published and disposes
 * itself), bounded startup recovery, tracked wakes, and the dispose-first
 * close sequencing. The module keeps admission, authorization generation,
 * and every durable decision; this class only owns Session mechanics.
 *
 * @module dsh-agent-swarm/skills/manager-lifecycle
 */
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import { z } from 'zod'
import { TeamDomainError } from '../domain/error.js'
import type { SkillsManagementStore, SkillsRequestRecord } from '../storage/skills-management.js'
import type { SkillsCallAuthority } from './contracts.js'
import type { SkillsManagementConfig } from './module.js'

export interface ManagerLifecycleDeps {
  readonly ctx: Context
  readonly store: SkillsManagementStore
  readonly config: SkillsManagementConfig
  generation(): number
  isAdmissionClosed(): boolean
  assertAdmission(): void
  /** The module-owned investigation face (tool bridge, no state here). */
  investigateTool(requestId: string, exec: SkillsCallAuthority): Promise<unknown>
  /** The module-owned batch acknowledgement face. */
  ackTool(batchId: string, outcome: string, exec: SkillsCallAuthority): Promise<unknown>
  /** Candidate capture through the candidate authority (author = this exact
   * live manager identity; the callback enforces it with object identity). */
  proposeTool(raw: unknown, exec: SkillsCallAuthority): Promise<unknown>
}

/** The single private, manager-scoped tool (investigate AND batch ack). */
const INVESTIGATE_TOOL_NAME = 'skills_management_investigate'

export class ManagerLifecycle {
  private handle: AgentHandle | undefined
  private opening: Promise<AgentHandle> | undefined
  private recovery: Promise<void> | undefined
  private readonly wakes = new Set<Promise<unknown>>()
  readonly closing = new AbortController()

  constructor(private readonly deps: ManagerLifecycleDeps) {}

  get agentHandle(): AgentHandle | undefined {
    return this.handle
  }

  /** Freshly take (and clear) the published handle, bypassing flow narrowing. */
  takeHandle(): AgentHandle | undefined {
    const handle = this.handle
    this.handle = undefined
    return handle
  }

  abortClosing(reason: unknown): void {
    this.closing.abort(reason)
  }

  /**
   * Lazily open the dedicated manager Agent on its durable Session identity:
   * an existing binding RESUMES the same Session through the official
   * `agents.resume({ resumeSessionId, signal, setup })` (same identity,
   * tools and permissions); only a never-bootstrapped identity falls back to
   * create under the SAME SessionId. Creation carries the module's
   * creation-only signal; the generation is re-checked both in the official
   * setup commit and after the call returns — a late handle is never
   * published and disposes itself.
   */
  async ensureManager(): Promise<AgentHandle | undefined> {
    const { ctx, store, config } = this.deps
    if (this.deps.isAdmissionClosed()) return undefined
    const provider = config.manager.provider
    const model = config.manager.model
    if (provider === undefined || model === undefined) return undefined
    const current = this.handle
    if (current !== undefined) return current
    this.opening ??= (async (): Promise<AgentHandle> => {
      const generation = this.deps.generation()
      const binding = store.getManagerBinding()
      const sessionId = await this.durableManagerSessionId()
      const setup = (agentCtx: Context): { commit(): void } => {
        // Official continuous narrowing of every inherited global tool
        // (including ones registered later); scoped registrations remain.
        agentCtx.tools.restrict({ allow: [] })
        this.registerInvestigateTool(agentCtx)
        this.registerProposalTool(agentCtx)
        return {
          // Official publication boundary re-check: closing/revocation that
          // landed during the setup awaits rolls the open back.
          commit: () => {
            this.deps.assertAdmission()
            if (generation !== this.deps.generation()) {
              throw new TeamDomainError('skills authorization generation changed while the manager was opening', 'SKILLS_REVOKED')
            }
          },
        }
      }
      const route = { provider, model }
      let handle: AgentHandle
      if (binding === undefined) {
        handle = await ctx.agents.create({ sessionId, agentOptions: route, setup, signal: this.closing.signal })
      } else {
        try {
          // The official resume does NOT restore routing from the old Session
          // header — prepareRequest reads provider/model from the CURRENT
          // options — so the re-authorized route must travel with the resume.
          handle = await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: route, setup, signal: this.closing.signal })
        } catch (error) {
          if (!this.isMissingSession(error)) throw error
          // A bound identity whose Session was never persisted (create died
          // before its first settled turn) is created under the SAME id.
          handle = await ctx.agents.create({ sessionId, agentOptions: route, setup, signal: this.closing.signal })
        }
      }
      if (this.deps.isAdmissionClosed() || generation !== this.deps.generation()) {
        // CLOSE COMPLETION includes releasing this module-owned late handle:
        // await its dispose BEFORE refusing, so a racing close never returns
        // with the handle still resident. Business Agents are untouched.
        await handle.dispose()
        throw new TeamDomainError('the skills-management module admission closed while the manager was opening', 'SKILLS_ADMISSION_CLOSED')
      }
      this.handle = handle
      return handle
    })()
    try {
      const opened = await this.opening
      return opened
    } finally {
      this.opening = undefined
    }
  }

  /** Host/fixture drain primitive: settles every full-cycle in-flight wake. */
  async flushWakes(): Promise<void> {
    await Promise.allSettled(this.wakes)
  }

  /**
   * Bounded startup recovery, owned by the single module owner at mount:
   * manifest-authorized requests still `received`/`investigating` (an
   * interrupted previous lifetime) are re-woken for the dedicated manager —
   * no second scheduler, no Captain replay.
   */
  startRecovery(): Promise<void> {
    this.recovery ??= (async (): Promise<void> => {
      if (this.deps.isAdmissionClosed()) return
      if (this.deps.config.manager.provider === undefined || this.deps.config.manager.model === undefined) return
      for (const pair of this.deps.config.management) {
        let pending: SkillsRequestRecord[]
        try {
          pending = this.deps.store.listRequestsByStates(pair.scope, pair.teamId, ['received', 'investigating'])
        } catch {
          continue // store gap stays visible via the durable records themselves
        }
        for (const record of pending) this.trackWake(record)
      }
    })()
    return this.recovery
  }

  /**
   * Dispose-first close sequencing: the official manager-handle dispose
   * (cancel → whenIdle → Session flush → unregister, OWN handle only) STARTS
   * first — it cancels in-flight turns so wakes waiting on whenIdle settle —
   * and only afterwards does `settle()` drain the late handle and all wakes.
   */
  beginClose(): { readonly disposal: Promise<void> | undefined; settle(): Promise<void> } {
    const handle = this.takeHandle()
    const opening = this.opening
    this.opening = undefined
    const disposal = handle?.dispose()
    return {
      disposal,
      settle: async (): Promise<void> => {
        if (opening !== undefined) {
          // A create/resume still in flight resolves into the generation
          // re-check inside ensureManager, which then refuses to publish and
          // disposes the late handle itself. Belt-and-braces: take anything
          // that still got published and release it here.
          await opening.catch(() => undefined)
          const late = this.takeHandle()
          if (late !== undefined) await late.dispose()
        }
        await Promise.allSettled(this.wakes)
      },
    }
  }

  trackWake(record: SkillsRequestRecord): void {
    // The wake carries the FULL key + revision + hash it was started for; a
    // late failure marker can never touch a newer revision of the request.
    const wake = this.wakeManager(record).catch(error => this.markWakeFailed(record, error))
    this.wakes.add(wake)
    void wake.finally(() => { this.wakes.delete(wake) })
  }

  private async wakeManager(record: SkillsRequestRecord): Promise<void> {
    if (!this.deps.config.management.some(entry => entry.scope === record.scope && entry.teamId === record.teamId)) return
    const handle = await this.ensureManager()
    if (handle === undefined || this.deps.isAdmissionClosed()) return
    handle.agent.followup(createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: `Skills request ${record.requestId} for team ${record.teamId} needs investigation: call ${INVESTIGATE_TOOL_NAME} with request_id ${record.requestId}. The activity view carries a batchId; after processing that bounded batch, call ${INVESTIGATE_TOOL_NAME} again with ack_batch_id and a bounded ack_outcome. Nothing acknowledges a batch automatically.` }],
    }))
    // The tracked wake covers the FULL cycle — model turn, scoped investigate
    // tool execution, durable persist — so flushWakes/close drain real work,
    // never just message admission.
    await handle.agent.whenIdle()
  }

  private async markWakeFailed(record: SkillsRequestRecord, error: unknown): Promise<void> {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    try {
      await this.deps.store.updateRequest(record.scope, record.teamId, record.requestId, current =>
        current.state === 'received' && current.revision === record.revision && current.payloadHash === record.payloadHash
          ? { ...current, state: 'failed', reason: `manager-wake-failed: ${detail.slice(0, 480)}` }
          : current)
    } catch {
      // A failed failure-marker never masks the original durable gap.
    }
  }

  private async durableManagerSessionId(): Promise<SessionId> {
    const existing = this.deps.store.getManagerBinding()
    if (existing !== undefined) return SessionId(existing.sessionId)
    const candidate = SessionId(`skills-manager-${Math.random().toString(36).slice(2, 10)}`)
    const binding = await this.deps.store.putManagerBindingIfAbsent(candidate) // durable-before-use
    return SessionId(binding.sessionId)
  }

  private isMissingSession(error: unknown): boolean {
    // OFFICIAL precision (agent-loop index.ts:496 precedent): ONLY the public
    // not-found class means "bound identity was never persisted". Corruption
    // and every other read/restore failure propagate explicitly — they must
    // NEVER be folded into the same-id create fallback.
    return error instanceof SessionPersistenceNotFoundError
  }

  /** The ONE private manager-scoped tool: bounded investigation AND explicit batch ack. */
  private registerInvestigateTool(agentCtx: Context): void {
    agentCtx.tools.register(defineTool({
      name: INVESTIGATE_TOOL_NAME,
      description: 'Read the authorized bounded work facts (activity batch + precise evidence) for one manifest-authorized skill request and durably record the outcome; or explicitly acknowledge a processed activity batch. Identity comes from the Host binding, never from arguments.',
      parameters: {
        request_id: { type: 'string', description: 'The skill request id to investigate (must be inside the Host management manifest).' },
        ack_batch_id: { type: 'string', description: 'Explicit acknowledgement branch: the batchId from the activity view. Ack proves only that this bounded batch was explicitly processed — never skill validity or benefit.' },
        ack_outcome: { type: 'string', description: 'Bounded processing conclusion for the acknowledged batch.' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args: unknown, value: string) => [{ type: 'text', text: value }],
      },
      isConcurrencySafe: () => false,
      execute: async (args, exec) => {
        const input = z.object({
          request_id: z.string().min(1).max(128).optional(),
          ack_batch_id: z.string().min(1).max(256).optional(),
          ack_outcome: z.string().min(1).max(512).optional(),
        }).strict().parse(args)
        if (input.ack_batch_id !== undefined || input.ack_outcome !== undefined) {
          if (input.ack_batch_id === undefined || input.ack_outcome === undefined) {
            throw new TeamDomainError('the acknowledgement branch needs both ack_batch_id and ack_outcome', 'SKILLS_INPUT_INVALID')
          }
          return JSON.stringify(await this.deps.ackTool(input.ack_batch_id, input.ack_outcome, exec as SkillsCallAuthority))
        }
        if (input.request_id === undefined) {
          throw new TeamDomainError('investigation needs request_id (or use the ack branch)', 'SKILLS_INPUT_INVALID')
        }
        return JSON.stringify(await this.deps.investigateTool(input.request_id, exec as SkillsCallAuthority))
      },
    }))
  }

  /** The manager's scoped candidate-capture tool: the manager's REAL calling
   * identity is the author (derived through the candidate authority from this
   * exact live handle), never an argument. Capture is not publication. */
  private registerProposalTool(agentCtx: Context): void {
    agentCtx.tools.register(defineTool({
      name: 'agent_swarm_skills_propose',
      description: 'Capture an immutable release candidate for a known skill request of a managed Team: binds the request, target version, optional approved base version and the SHA-256 of the exact captured body. The author is your own derived manager identity — never an argument. The same version slot with a different body conflicts; publication requires an independent Captain review of this exact capture.',
      parameters: {
        request_id: { type: 'string', required: true, description: 'A known skill request id of the owning Team.' },
        skill_name: { type: 'string', required: true, description: 'The skill name the candidate revises.' },
        version: { type: 'string', required: true, description: 'The NEW candidate version (immutable slot).' },
        base_version: { type: 'string', description: 'Optional approved version this candidate revises.' },
        provider: { type: 'string', required: true, description: 'The provider the body was captured from.' },
        locator: { type: 'string', required: true, description: 'The provider locator behind the captured body.' },
        body: { type: 'string', required: true, description: 'The exact captured body text.' },
        applicability: { type: 'string', required: true, description: 'When this candidate applies.' },
        verification: { type: 'string', required: true, description: 'The verification evidence behind the proposal.' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args: unknown, value: string) => [{ type: 'text', text: value }],
      },
      isConcurrencySafe: () => false,
      execute: async (args, exec) => JSON.stringify(await this.deps.proposeTool(args, exec as SkillsCallAuthority)),
    }))
  }
}
