/**
 * Member tool-permission policy composition (M5-2, issue #136 / F17).
 *
 * The official toolFilter seam scopes a continuable child's tools in its
 * creation window only (`applyChildComposition` → scoped `tools.restrict()`,
 * snapshotted into the durable descriptor, replayed on cold resume) — the
 * followup face carries no composition, so a member's host-tool policy is
 * declared once, by the captain, at provisioning (design note
 * `docs/development/2026-08-22-m5b-permission-family-design.md` §2).
 *
 * This module composes that declaration with the M1A static baseline. The
 * composition is DENY-ONLY and monotone: the captain-only administration
 * tools stay mandatorily denied, a declaration can only narrow further, and
 * there is deliberately no `allow` surface — a corrupted or injected
 * declaration can lock a member out (loud, recoverable by provisioning a new
 * member), never escalate it. Structural validation is plugin-side; tool-name
 * EXISTENCE stays with the official seam: `tools.restrict()` rejects unknown
 * global names inside the child's creation window, `startContinuable` fails,
 * and the provisioning record settles failed (fail-loud, no silent member
 * without its declared policy).
 */
import { TeamDomainError } from '../domain/error.js'
import { CAPTAIN_ONLY_TOOLS } from './prompts.js'

/** Bound on one declaration: a deny list longer than every global tool set is a mistake. */
export const MAX_DENY_TOOLS = 64
/** R2/member-profile bound; tool names are ASCII under TOOL_NAME_PATTERN. */
export const MAX_DENY_TOOL_NAME_LENGTH = 256

/**
 * Structural tool-name shape. Deliberately permissive toward real tool names
 * (`agent_swarm_send_message`, `bash`, …) while rejecting whitespace,
 * control characters, fences and path-shaped strings — existence remains the
 * official seam's authority.
 */
export const TOOL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/

/**
 * Compose one member's provisioning-time tool deny list: the mandatory
 * captain-only baseline plus the captain-declared narrowing names, deduped,
 * baseline-first for a stable order.
 *
 * @param declared - optional captain-declared deny names (`deny_tools`).
 * @returns the deny list for the official `toolFilter`.
 * @throws `TEAM_TOOL_POLICY_INVALID` on any structurally invalid declaration.
 */
export function memberToolDeny(declared?: readonly string[]): string[] {
  if (declared === undefined) return [...CAPTAIN_ONLY_TOOLS]
  if (declared.length > MAX_DENY_TOOLS) {
    throw new TeamDomainError(`deny_tools must name at most ${MAX_DENY_TOOLS} tools (got ${declared.length})`, 'TEAM_TOOL_POLICY_INVALID')
  }
  const seen = new Set<string>()
  for (const name of declared) {
    if (typeof name !== 'string' || name.trim() === '' || name.length > MAX_DENY_TOOL_NAME_LENGTH || !TOOL_NAME_PATTERN.test(name)) {
      throw new TeamDomainError(`deny_tools entries must be non-empty tool names of at most ${MAX_DENY_TOOL_NAME_LENGTH} characters matching ${String(TOOL_NAME_PATTERN)} (got ${JSON.stringify(name)})`, 'TEAM_TOOL_POLICY_INVALID')
    }
    if (seen.has(name)) {
      throw new TeamDomainError(`deny_tools must not repeat a tool name (${JSON.stringify(name)})`, 'TEAM_TOOL_POLICY_INVALID')
    }
    seen.add(name)
  }
  // Union with the mandatory baseline: declaring a captain-only name is an
  // idempotent no-op the union absorbs — there is no widening path.
  return [...new Set([...CAPTAIN_ONLY_TOOLS, ...declared])]
}
