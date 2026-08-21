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
import type { AgentSwarmRuntime } from './orchestrator-runtime.js'

export interface RuntimeConfig {
  readonly memberProvider: string
  readonly memberModel?: string
  readonly memberMaxDepth: number
  readonly schedulerProvider: string
  readonly reviewProvider: string
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
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Authoritative host API; model tools are only one Consumer. */
    agentSwarm: AgentSwarmRuntime
  }
}
