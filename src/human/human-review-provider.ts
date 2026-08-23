/**
 * SW-I1a HumanReviewProvider.
 *
 * This TeamReviewProvider presents the submitted attempt through the OFFICIAL
 * `ctx.userQuestions` seam. It is deliberately captain-only by construction:
 * the provider receives the exact reviewing captain from the review
 * transaction, and the official service rejects any delegated/owned child
 * with `DELEGATED_CALLER`. It never uses `ctx.approval` — approval is
 * reserved for a concrete same-turn tool call, not for asynchronous
 * Team review.
 */
import type { Context } from '@deepseek-ai/cordis'
import { TeamDomainError } from '../domain/error.js'
import type { TeamReviewProvider } from '../runtime/providers.js'

const HUMAN_QUESTIONS_LABELS = {
  accept: 'Accept',
  reject: 'Reject',
} as const

/** Builtin `human` review provider over the official user-questions seam. */
export function humanReviewProvider(ctx: Context): TeamReviewProvider {
  return {
    async review(input) {
      const questions = ctx.get('userQuestions')
      if (questions === undefined) {
        throw new TeamDomainError(
          'Human review requires the official ctx.userQuestions service',
          'TEAM_HUMAN_QUESTIONS_MISSING',
        )
      }
      const detail = input.task.output ?? input.attempt.output
      const answer = await questions.ask({
        agent: input.captain,
        signal: input.signal,
        questions: [{
          id: `review-${input.team.id}-${input.task.id}-${input.attempt.id}`,
          question: `Accept submitted task "${input.task.subject}" for Team "${input.team.name}"?`,
          ...(detail === undefined ? {} : { detail: detail.slice(0, 4_000) }),
          options: [
            { label: HUMAN_QUESTIONS_LABELS.accept },
            { label: HUMAN_QUESTIONS_LABELS.reject },
          ],
        }],
      })
      if (answer.answers.length !== 1) {
        throw new TeamDomainError('human review must answer exactly one question', 'TEAM_HUMAN_REVIEW_INVALID_ANSWER')
      }
      const item = answer.answers[0]!
      const selected = item.selected
      if (selected.length !== 1
        || (selected[0] !== HUMAN_QUESTIONS_LABELS.accept && selected[0] !== HUMAN_QUESTIONS_LABELS.reject)) {
        throw new TeamDomainError(
          'human review answer must select exactly one offered Accept/Reject option',
          'TEAM_HUMAN_REVIEW_INVALID_ANSWER',
        )
      }
      const decision = selected[0] === HUMAN_QUESTIONS_LABELS.accept ? 'accept' : 'reject'
      return {
        decision,
        ...(item.custom === undefined
          ? input.diagnostic === undefined ? {} : { diagnostic: input.diagnostic }
          : { diagnostic: item.custom }),
      }
    },
  }
}
