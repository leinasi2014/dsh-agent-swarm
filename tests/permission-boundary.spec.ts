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
  reviewerCandidateIdentity,
  reviewerAgentVerdictHasNoTeamMutation,
  toHumanReviewDecision,
  type ReviewerAgentVerdict,
} from '../src/runtime/reviewer-boundary.js'
import { AttemptId, TaskId, TeamId, type TaskAttempt, type TeamState, type TeamTask } from '../src/domain/types.js'
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
  it('freezes a secret-free candidate identity from the current authoritative attempt', () => {
    const candidate = reviewerFixture({ output: 'output token=private-output', evidence: ['alpha', 'beta'] })
    const identity = reviewerCandidateIdentity(candidate)
    expect(identity).toMatchObject({
      teamId: 'team-reviewer', teamRevision: 9, taskId: 'task-reviewer', taskRevision: 4,
      attemptId: 'attempt-reviewer', attemptGeneration: 2, memberSessionId: 'member-reviewer',
    })
    expect(identity.outputSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(identity.evidenceSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(identity)).not.toMatch(/private-output|alpha|beta/)
    expect(reviewerCandidateIdentity(reviewerFixture({ evidence: ['beta', 'alpha'] })).evidenceSha256)
      .not.toBe(identity.evidenceSha256)
    expect(reviewerCandidateIdentity(reviewerFixture({ evidence: ['a', 'bc'] })).evidenceSha256)
      .not.toBe(reviewerCandidateIdentity(reviewerFixture({ evidence: ['ab', 'c'] })).evidenceSha256)
    expect(Object.isFrozen(identity)).toBe(true)
  })
  it('fails loud before a reviewer can see a stale or inconsistent candidate', () => {
    const candidate = reviewerFixture()
    expect(() => reviewerCandidateIdentity({ ...candidate, task: { ...candidate.task } }))
      .toThrowError(expect.objectContaining({ code: 'TEAM_REVIEW_CANDIDATE_INVALID' }))
    expect(() => reviewerCandidateIdentity({ ...candidate, attempt: { ...candidate.attempt, taskId: TaskId('other-task') } }))
      .toThrowError(expect.objectContaining({ code: 'TEAM_REVIEW_CANDIDATE_INVALID' }))
    expect(() => reviewerCandidateIdentity({
      ...candidate,
      task: { ...candidate.task, currentAttemptId: AttemptId('replacement-attempt') },
    })).toThrowError(expect.objectContaining({ code: 'TEAM_REVIEW_CANDIDATE_INVALID' }))
  })
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
    expect(decision).toEqual({
      decision: 'reject',
      diagnostic: 'reviewer evidence [e1]; recommendation=reject; provenance=reviewer-agent',
    })
  })
  it('fails loud without exposing free reviewer diagnostics when evidence has no recommendation', () => {
    const injected = 'C:\\private\\review token=secret-reviewer'
    let thrown: unknown
    try {
      toHumanReviewDecision({ kind: 'evidence', evidenceIds: ['e1'], diagnostic: injected })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toMatchObject({
      code: 'TEAM_REVIEWER_EVIDENCE_ONLY',
      message: 'reviewer evidence without an explicit recommendation cannot settle the review',
    })
    expect(JSON.stringify(thrown)).not.toMatch(/private|secret-reviewer/)
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

function reviewerFixture(overrides: { output?: string; evidence?: string[] } = {}): {
  readonly team: TeamState
  readonly task: TeamTask
  readonly attempt: TaskAttempt
} {
  const task: TeamTask = {
    id: TaskId('task-reviewer'), revision: 4, subject: 'Review', description: 'Review candidate',
    acceptanceCriteria: [], status: 'submitted', blockedBy: [], writeScopes: [], priority: 0,
    currentAttemptId: AttemptId('attempt-reviewer'), createdAt: 1, updatedAt: 2,
  }
  const attempt: TaskAttempt = {
    id: AttemptId('attempt-reviewer'), taskId: task.id, generation: 2, memberSessionId: 'member-reviewer',
    phase: 'submitted', assignmentPhase: 'delivered', output: overrides.output ?? 'candidate output',
    evidence: overrides.evidence ?? ['evidence-1'], createdAt: 1, updatedAt: 2,
  }
  return {
    team: {
      schemaVersion: 1, id: TeamId('team-reviewer'), revision: 9, name: 'Reviewer team', description: 'Test team',
      captainSessionId: 'captain-reviewer', phase: 'active', members: [], tasks: [task], attempts: [attempt], messages: [],
      budget: { usedTokens: 0, usedRequests: 0, usedRetries: 0 }, usageCursors: {}, memory: [],
      nextTaskNumber: 2, nextMemoryNumber: 1, createdAt: 1, updatedAt: 2,
    },
    task,
    attempt,
  }
}
