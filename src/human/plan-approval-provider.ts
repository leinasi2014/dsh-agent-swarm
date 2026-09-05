/**
 * Official `ctx.userQuestions` seam for the plan-first approval gate (P0-2 S3).
 * The Main Brain asks exactly one approve/discard question; the service is
 * resolved at call time so plugins registering later still work, and a missing
 * service fails loud (never a silent auto-approve).
 * @module dsh-agent-swarm/human/plan-approval-provider
 */
import type { Context } from '@deepseek-ai/cordis'
import { TeamDomainError } from '../domain/error.js'
import type { PlanApprovalPort } from '../runtime/runtime-contract.js'

export function officialPlanApprovalProvider(ctx: Context): PlanApprovalPort {
  return {
    async ask(input) {
      const questions = ctx.get('userQuestions')
      if (questions === undefined) {
        throw new TeamDomainError('Plan approval requires the official ctx.userQuestions service', 'TEAM_HUMAN_QUESTIONS_MISSING')
      }
      const answer = await questions.ask({
        agent: input.agent,
        signal: input.signal,
        questions: [{
          id: `plan-approve-${input.teamId}`,
          question: input.question,
          options: [{ label: input.approveLabel }, { label: input.discardLabel }],
        }],
      })
      if (answer.answers.length !== 1) {
        throw new TeamDomainError('plan approval must answer exactly one question', 'TEAM_HUMAN_REVIEW_INVALID_ANSWER')
      }
      const selected = answer.answers[0]!.selected
      if (selected.length === 1 && selected[0] === input.approveLabel) return 'approve'
      if (selected.length === 1 && selected[0] === input.discardLabel) return 'discard'
      throw new TeamDomainError('plan approval answer must select one offered option', 'TEAM_HUMAN_REVIEW_INVALID_ANSWER')
    },
  }
}
