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

/**
 * Per-session effective tool workspace (issue #191 / M3-1). While a member
 * works one fenced attempt, its shell/file tools must execute inside the
 * attempt's execution root — not the shared roster Session cwd it was
 * provisioned with. This registry holds the root path for exactly the
 * session(s) currently working a fenced attempt, consulted by
 * {@link workspaceOf}. It is deliberately NOT the Team scope authority:
 * {@link AgentSwarmRuntime.scopeOf} derives the Team namespace from the
 * stable session header cwd, so the fenced root never becomes the Team scope
 * key (which would break member submit/sendMessage).
 *
 * Plugin-side transient state keyed by session id (seeded once per acquired
 * execution root, cleared when the root is reclaimed); never a second
 * canonical authority and never part of a Team aggregate.
 */
const executionWorkspaces = new Map<string, string>()

/**
 * Bind one agent session to its per-attempt execution root, making that root
 * the session's effective tool workspace until the attempt settles. The
 * binding is keyed by the session id and returns a disposer that clears
 * exactly this binding (idempotent against a newer binding for the same
 * session).
 *
 * @returns a disposer that removes the binding, leaving the session's stable
 * tool workspace (its header cwd) intact again.
 */
export function bindExecutionWorkspace(sessionId: string, rootPath: string): () => void {
  executionWorkspaces.set(sessionId, rootPath)
  return () => {
    if (executionWorkspaces.get(sessionId) === rootPath) executionWorkspaces.delete(sessionId)
  }
}

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

/**
 * The agent session's canonical workspace directory: the per-attempt
 * execution root while the member works a fenced attempt (issue #191), else
 * the stable session header cwd.
 */
export function workspaceOf(agent: Agent): string {
  return executionWorkspaces.get(String(agent.id)) ?? agent.session.header.cwd ?? process.cwd()
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
