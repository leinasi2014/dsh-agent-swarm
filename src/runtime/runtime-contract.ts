/**
 * The orchestrator runtime's public contract: its configuration shape and
 * the `ctx.agentSwarm` service surface (declaration merging), extracted from
 * `orchestrator-runtime.ts` to keep that implementation under the source
 * size gate. The augmentation is ambient — moving it here changes no
 * behavior, only where the type is declared.
 * @module dsh-agent-swarm/runtime/runtime-contract
 */

import type { TeamLimits } from '../domain/types.js'
import type { OrchestrationMode } from './orchestration-ownership.js'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AgentSwarmRuntime } from './orchestrator-runtime.js'
import type { TeamSkillSurface } from './team-skill-surface.js'


/** Official human approval seam for the plan-first gate (P0-2 S3). */
export interface PlanApprovalPort {
  readonly ask: (input: {
    readonly agent: Agent
    readonly signal: AbortSignal
    readonly teamId: string
    readonly question: string
    readonly approveLabel: string
    readonly discardLabel: string
  }) => Promise<'approve' | 'discard'>
}
export interface RuntimeConfig {
  readonly memberProvider: string
  readonly memberLlmProvider?: string
  readonly memberModel?: string
  readonly captainLlmProvider?: string
  readonly captainModel?: string
  readonly memberMaxDepth: number
  readonly schedulerProvider: string
  readonly reviewProvider: string
  /** Optional official userQuestions gate for plan approval (fail-closed when absent). */
  readonly planApproval?: PlanApprovalPort
  /**
   * Review execution root supply name (M3-2, issue #101): builtin `temp`
   * (plain temp directory) or a registered #100-family Provider. Consumed
   * by the `executable` review Provider; preflight-checked like the
   * scheduler/review Provider names.
   */
  readonly reviewRootProvider: string
  /** Explicit orchestration mode (M2-3, issue #77; docs/04 §8g). */
  readonly orchestrationMode: OrchestrationMode
  readonly limits: TeamLimits
  /**
   * Bound for every disposal settlement step (F4), aligned with the official
   * experimental `disposalTimeoutMs` (default 5000). Positive safe integer.
   */
  readonly disposalTimeoutMs: number
  /**
   * Stranded-ownership grace bound (issue #12 / F10): a live-and-idle member
   * holding an open in_progress task is retried under a fresh attempt once
   * this many milliseconds elapsed since the task's last transition. Safe
   * non-negative integer; 0 disables automatic retry (evidence-only
   * `stranded=` hints remain). Decisions: docs/04 §8c.
   */
  readonly strandedAfterMs: number
  /**
   * Per-attempt execution roots (M3-1, issue #100; docs/04 §8l): when true,
   * every claimed attempt is fenced into an isolated physical working root
   * supplied by the configured Provider (default `git-worktree`), released
   * when the attempt settles and scanned for crash residue at activation.
   */
  readonly executionRootsEnabled: boolean
  /** Registered execution-root Provider name (default `git-worktree`). */
  readonly executionRootProvider: string
  /** Absolute base directory under which every execution root is laid out. */
  readonly executionRootsBase: string
  /** Effective ask + deny policy names hidden from delegated members. */
  readonly memberToolPolicyDeny: readonly string[]
  /** Snapshot default persisted onto a newly created Team. */
  readonly newTeamAllowedSkills: () => readonly string[]
  /** Scoped loader composition for Captain/member continuable Sessions. */
  readonly teamSkills: TeamSkillSurface
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Authoritative host API; model tools are only one Consumer. */
    agentSwarm: AgentSwarmRuntime
  }
}

