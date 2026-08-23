/**
 * SW-I1a Reviewer Agent / HumanReviewProvider ownership boundary.
 *
 * A Reviewer Agent is an evidence producer inside the Team review pipeline:
 * it examines candidate output and may offer a recommendation, but it never
 * owns a Team mutation handle. `HumanReviewProvider` (or the executable/
 * manual Providers behind it) produces a `ReviewProviderResult`, and only the
 * existing captain review transaction (`runReviewTransaction` →
 * `TeamDomainPort.reviewTask`) commits the final accept/reject transition.
 *
 * This module freezes that boundary as a deterministic, testable contract:
 * any object carrying a `decision` or a domain-port handle is NOT a reviewer
 * verdict, and a human review decision without an explicit reviewer
 * recommendation stays evidence-only (fails loud rather than fabricating a
 * verdict).
 */
import { Buffer } from 'node:buffer'
import { TeamDomainError } from '../domain/error.js'
import type { ReviewProviderResult, TeamReviewProvider } from './providers.js'

/** What a Reviewer Agent may return: evidence, optionally a recommendation. */
export interface ReviewerAgentVerdict {
  readonly kind: 'evidence'
  readonly evidenceIds: readonly string[]
  readonly diagnostic: string
  readonly recommendation?: 'accept' | 'reject'
}

/** Reviewer Agent Provider contract: no Team mutation surface. */
export interface ReviewerAgentProvider {
  readonly kind: 'reviewer-agent'
  readonly name: string
  review(input: {
    readonly workspace: string
    readonly diagnostic?: string
    readonly signal: AbortSignal
  }): ReviewerAgentVerdict | Promise<ReviewerAgentVerdict>
}

const MAX_REVIEWER_EVIDENCE_IDS = 16
const MAX_REVIEWER_EVIDENCE_ID_BYTES = 96
const MAX_REVIEWER_DIAGNOSTIC_BYTES = 2_048
const EVIDENCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/

/** A reviewer verdict must not smuggle a decision or a mutation handle. */
export function reviewerAgentVerdictHasNoTeamMutation(value: unknown): value is ReviewerAgentVerdict {
  if (typeof value !== 'object' || value === null) return false
  const verdict = value as Record<string, unknown>
  if (verdict.kind !== 'evidence') return false
  if (Object.keys(verdict).some(key => !['kind', 'evidenceIds', 'diagnostic', 'recommendation'].includes(key))) return false
  if (!Array.isArray(verdict.evidenceIds)
    || verdict.evidenceIds.length < 1
    || verdict.evidenceIds.length > MAX_REVIEWER_EVIDENCE_IDS) return false
  const ids = verdict.evidenceIds
  if (!ids.every(id => typeof id === 'string'
    && EVIDENCE_ID_PATTERN.test(id)
    && Buffer.byteLength(id, 'utf8') <= MAX_REVIEWER_EVIDENCE_ID_BYTES)) return false
  if (new Set(ids).size !== ids.length) return false
  if (typeof verdict.diagnostic !== 'string'
    || verdict.diagnostic.trim() === ''
    || Buffer.byteLength(verdict.diagnostic, 'utf8') > MAX_REVIEWER_DIAGNOSTIC_BYTES) return false
  return verdict.recommendation === undefined || verdict.recommendation === 'accept' || verdict.recommendation === 'reject'
}

/** Stable, safe evidence binding that the existing review diagnostic persists. */
function reviewerEvidenceBinding(verdict: ReviewerAgentVerdict): string {
  return `reviewer evidence [${verdict.evidenceIds.join(', ')}]; recommendation=${verdict.recommendation}; provenance=reviewer-agent`
}

/** Turn a reviewer evidence verdict into an explicit HumanReviewProvider decision. */
export function toHumanReviewDecision(verdict: ReviewerAgentVerdict): ReviewProviderResult {
  if (!reviewerAgentVerdictHasNoTeamMutation(verdict)) {
    throw new TeamDomainError(
      'a Reviewer Agent produced a non-evidence object (decision/domain handle); the review transaction owns all Team mutation',
      'TEAM_REVIEWER_EVIDENCE_ONLY',
    )
  }
  if (verdict.recommendation === undefined) {
    throw new TeamDomainError(
      'reviewer evidence without an explicit recommendation cannot settle the review',
      'TEAM_REVIEWER_EVIDENCE_ONLY',
    )
  }
  return {
    decision: verdict.recommendation,
    diagnostic: reviewerEvidenceBinding(verdict),
  }
}

/**
 * Real integration with the existing review Provider/transaction: this
 * factory wraps a registered evidence-only Reviewer Agent into the
 * `TeamReviewProvider` contract consumed by `runReviewTransaction`. The
 * provider has no Team mutation handle; the transaction (→
 * `TeamDomainPort.reviewTask`) remains the only writer.
 */
export function reviewerAgentReviewProvider(resolve: () => ReviewerAgentProvider | undefined): TeamReviewProvider {
  return {
    async review(input) {
      const provider = resolve()
      if (provider === undefined) {
        throw new TeamDomainError(
          'reviewer-agent Provider is unavailable; register one through ctx.agentSwarmPermission.registerReviewerAgentProvider',
          'TEAM_REVIEW_PROVIDER_MISSING',
        )
      }
      let verdict: ReviewerAgentVerdict
      try {
        verdict = await provider.review({
          workspace: input.workspace,
          ...(input.diagnostic === undefined ? {} : { diagnostic: input.diagnostic }),
          signal: input.signal,
        })
      } catch {
        throw new TeamDomainError('reviewer-agent Provider failed without producing valid evidence', 'TEAM_REVIEW_PROVIDER_FAILED')
      }
      try {
        return toHumanReviewDecision(verdict)
      } catch (error) {
        if (error instanceof TeamDomainError) throw error
        throw new TeamDomainError('reviewer-agent Provider produced unreadable evidence', 'TEAM_REVIEW_PROVIDER_FAILED')
      }
    },
  }
}
