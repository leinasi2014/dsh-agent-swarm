/**
 * SW-I1a permission boundary (pure half): the monotone allow/ask/deny
 * decision model, the Agent-mint-free human provenance classification and
 * the Reviewer evidence-only contract. The real ToolRuntime/approval
 * composition half lives in `permission-real-composition.spec.ts`.
 */
import { describe, expect, it } from 'vitest'
import {
  decideToolPermission,
  DEFAULT_TOOL_PERMISSION,
  MAX_TOOL_POLICY_NAMES,
  memberToolPolicyFilter,
  mergeToolPolicy,
  mostRestrictiveToolDecision,
  toPreToolDecision,
  validateToolPolicyDeclaration,
  type ToolCallerRole,
  type ToolPermissionContext,
  type ToolPolicyDeclaration,
} from '../src/runtime/permission-policy.js'
import { assertFreeTextNotAuthorization } from '../src/runtime/human-provenance.js'
import {
  reviewerAgentVerdictHasNoTeamMutation,
  toHumanReviewDecision,
  type ReviewerAgentVerdict,
} from '../src/runtime/reviewer-boundary.js'
describe('tiered allow/ask/deny decision model (pure)', () => {
  it('fails closed by default: an unlisted tool is deny and maps to a deny PreToolDecision', () => {
    const decision = decideToolPermission({}, 'agent_swarm_unknown', {
      callerRole: 'captain',
      sameTurnConcreteToolCall: true,
      openTurn: true,
      approvalSeamAvailable: true,
    })
    expect(decision).toBe(DEFAULT_TOOL_PERMISSION)
    expect(decision).toBe('deny')
    expect(toPreToolDecision(decision, 'agent_swarm_unknown')).toMatchObject({ kind: 'deny' })
    expect(MAX_TOOL_POLICY_NAMES).toBe(64)
  })
  it('is monotone: deny outranks ask outranks allow, and merging never widens', () => {
    expect(mostRestrictiveToolDecision('allow', 'ask')).toBe('ask')
    expect(mostRestrictiveToolDecision('ask', 'deny')).toBe('deny')
    expect(mostRestrictiveToolDecision('allow', 'deny')).toBe('deny')
    const merged = mergeToolPolicy(
      { deny: ['bash'], ask: ['write'], allow: ['read'] },
      { allow: ['bash', 'write'] },
    )
    expect(decideToolPermission(merged, 'bash', captainTurn())).toBe('deny')
    expect(decideToolPermission(merged, 'write', captainTurn())).toBe('ask')
    expect(decideToolPermission(merged, 'read', captainTurn())).toBe('allow')
  })
  it('rejects ambiguous multi-tier declarations loud', () => {
    expect(() => validateToolPolicyDeclaration({ allow: ['bash'], ask: ['bash'] }))
      .toThrowError(expect.objectContaining({ code: 'TEAM_TOOL_POLICY_INVALID' }))
    expect(() => validateToolPolicyDeclaration({ ask: ['bash'], deny: ['bash'] }))
      .toThrowError(expect.objectContaining({ code: 'TEAM_TOOL_POLICY_INVALID' }))
  })
  it('grants ask only to a captain on a concrete same-turn tool call with an available approval seam', () => {
    const policy: ToolPolicyDeclaration = { ask: ['bash'] }
    expect(decideToolPermission(policy, 'bash', { ...captainTurn(), callerRole: 'delegated-member' })).toBe('deny')
    expect(decideToolPermission(policy, 'bash', { ...captainTurn(), sameTurnConcreteToolCall: false })).toBe('deny')
    expect(decideToolPermission(policy, 'bash', { ...captainTurn(), openTurn: false })).toBe('deny')
    expect(decideToolPermission(policy, 'bash', { ...captainTurn(), approvalSeamAvailable: false })).toBe('deny')
    expect(decideToolPermission(policy, 'bash', captainTurn())).toBe('ask')
    expect(toPreToolDecision('ask', 'bash')).toMatchObject({ kind: 'ask' })
  })
  it('maps asked tools to deny in the delegated-member provisioning filter', () => {
    const filter = memberToolPolicyFilter({ allow: ['read'], ask: ['bash'], deny: ['agent_swarm_send_message'] })
    expect(filter.deny).toContain('bash')
    expect(filter.deny).toContain('agent_swarm_send_message')
    expect(filter.deny).not.toContain('read')
  })
  it('rejects a replayed/stale approval context: an old open turn cannot authorize a new call', () => {
    const policy: ToolPolicyDeclaration = { ask: ['bash'] }
    expect(decideToolPermission(policy, 'bash', { ...captainTurn(), openTurn: false })).toBe('deny')
    expect(decideToolPermission(policy, 'bash', { ...captainTurn(), sameTurnConcreteToolCall: false })).toBe('deny')
  })
})
describe('human provenance boundary (no Agent-mintable attestation)', () => {
  it('free-text Message content cannot authorize a structured Control', () => {
    expect(() => assertFreeTextNotAuthorization({ freeTextOnly: true, structuredControl: true }))
      .toThrowError(expect.objectContaining({ code: 'TEAM_HUMAN_FREE_TEXT_NOT_AUTHORIZATION' }))
  })
})
describe('Reviewer Agent / HumanReviewProvider boundary', () => {
  it('accepts only evidence verdicts without a decision or mutation handle', () => {
    const verdict: ReviewerAgentVerdict = {
      kind: 'evidence',
      evidenceIds: ['evidence-1'],
      diagnostic: 'root evidence only',
      recommendation: 'reject',
    }
    expect(reviewerAgentVerdictHasNoTeamMutation(verdict)).toBe(true)
    expect(reviewerAgentVerdictHasNoTeamMutation({ kind: 'evidence', evidenceIds: ['e1'], diagnostic: 'x', decision: 'accept' })).toBe(false)
    expect(reviewerAgentVerdictHasNoTeamMutation({ kind: 'evidence', evidenceIds: ['e1'], diagnostic: 'x', teamDomainPort: {} })).toBe(false)
    expect(reviewerAgentVerdictHasNoTeamMutation({ kind: 'decision', decision: 'accept' })).toBe(false)
    expect(reviewerAgentVerdictHasNoTeamMutation({ kind: 'evidence', evidenceIds: [], diagnostic: 'x', recommendation: 'accept' })).toBe(false)
    expect(reviewerAgentVerdictHasNoTeamMutation({ kind: 'evidence', evidenceIds: ['e1', 'e1'], diagnostic: 'x', recommendation: 'accept' })).toBe(false)
    expect(reviewerAgentVerdictHasNoTeamMutation({ kind: 'evidence', evidenceIds: ['e1'], diagnostic: '', recommendation: 'accept' })).toBe(false)
    expect(reviewerAgentVerdictHasNoTeamMutation({ kind: 'evidence', evidenceIds: ['e1'], diagnostic: 'x', recommendation: 'maybe' })).toBe(false)
  })
  it('turns an explicit reviewer recommendation into a ReviewProviderResult', () => {
    const decision = toHumanReviewDecision({
      kind: 'evidence',
      evidenceIds: ['e1'],
      diagnostic: 'verification root failed',
      recommendation: 'reject',
    })
    expect(decision).toEqual({ decision: 'reject', diagnostic: 'reviewer evidence [e1]: verification root failed' })
  })
  it('fails loud when reviewer evidence has no recommendation', () => {
    expect(() => toHumanReviewDecision({ kind: 'evidence', evidenceIds: ['e1'], diagnostic: 'ambiguous' }))
      .toThrowError(expect.objectContaining({ code: 'TEAM_REVIEWER_EVIDENCE_ONLY', message: expect.stringContaining('e1') }))
  })
})
function captainTurn(): ToolPermissionContext {
  return {
    callerRole: 'captain' as ToolCallerRole,
    sameTurnConcreteToolCall: true,
    openTurn: true,
    approvalSeamAvailable: true,
  }
}
