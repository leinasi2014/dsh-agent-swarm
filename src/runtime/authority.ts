/**
 * Tool-call authority derivation for the host runtime.
 *
 * Identity always derives from the live `exec.agent` — never from
 * caller-supplied strings — and the canonical workspace key derives from the
 * agent session cwd.
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CallId } from '@deepseek-ai/dsh-llm'
import { TeamDomainError } from '../domain/error.js'

/** Execution context of one model tool call. */
export interface ToolExecutionAuthority {
  readonly agent?: Agent
  readonly signal: AbortSignal
  /**
   * The executing tool call's identity, surfaced from the full ToolRunContext
   * so the runtime can resolve the durable operation identity (MainBrainSessionId
   * + turn) by matching it to the Main Brain Session log's `tool/call` event.
   * The tools boundary passes these through; they are absent only when a caller
   * constructs an authority without a callId (never on the live tool path).
   */
  readonly callId?: CallId
  readonly rootCallId?: CallId
}

/** Resolve the backing Agent or fail loud: Team tools are Agent-backed only. */
export function requireAgent(exec: ToolExecutionAuthority): Agent {
  if (exec.agent === undefined) {
    throw new TeamDomainError('Team tools require an Agent-backed DSH session', 'TEAM_AGENT_REQUIRED')
  }
  return exec.agent
}

/** Stable Session workspace used by the Captain's review context. */
export function workspaceOf(agent: Agent): string {
  return agent.session.header.cwd ?? process.cwd()
}

/**
 * Validate the public wait-tool timeout bounds (issue #19, official
 * experimental `TeamActivity.wait` window parity): an integer from ten
 * seconds through one hour.
 */
export function expectDomainTimeout(value: number): void {
  if (!Number.isSafeInteger(value) || value < 10_000 || value > 3_600_000) {
    throw new TeamDomainError('timeout_ms must be an integer from 10000 through 3600000', 'TEAM_INVALID_TIMEOUT')
  }
}
