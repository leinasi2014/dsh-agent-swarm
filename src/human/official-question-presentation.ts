/**
 * SW-I1a CaptainQuestionPresentation over official `ctx.userQuestions`.
 *
 * The adapter resolves the EXACT live root Agent from the durable record's
 * `source.captainSessionId` and asks through the official service. It never
 * fabricates an answer: without the official service the apply assembly
 * leaves the presentation undefined and CaptainLiaison fails closed; an
 * invalid answer (not exactly one, not matching the asked id, or an empty
 * custom) also fails closed before any answer mail is routed.
 */
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { expectDomain } from '../domain/error.js'
import type { CaptainQuestion, CaptainQuestionPresentation } from './human-interaction-contract.js'

const QUESTION_ID_PREFIX = 'question-'

/**
 * Build the official presentation adapter for `ctx.userQuestions`, or
 * `undefined` when that official optional service is not composed.
 */
export function officialCaptainQuestionPresentation(ctx: Context): CaptainQuestionPresentation | undefined {
  const questions = ctx.get('userQuestions')
  if (questions === undefined) return undefined
  return {
    async ask(question: CaptainQuestion): Promise<string> {
      const captain = ctx.agents.get(SessionId(question.captainSessionId))
      expectDomain(
        captain !== undefined && ctx.agents.roots().includes(captain),
        'Human question presentation requires the exact live root captain from the durable record',
        'TEAM_INTERACTION_CAPTAIN_REQUIRED',
      )
      const questionId = `${QUESTION_ID_PREFIX}${question.requestId}`
      const answer = await questions.ask({
        agent: captain,
        questions: [{ id: questionId, question: question.question }],
      })
      expectDomain(
        answer.answers.length === 1,
        'human question must be answered exactly once',
        'TEAM_HUMAN_QUESTIONS_INVALID_ANSWER',
      )
      const item = answer.answers[0]!
      expectDomain(
        item.id === questionId,
        'human question answer must match the asked question id',
        'TEAM_HUMAN_QUESTIONS_INVALID_ANSWER',
      )
      expectDomain(
        typeof item.custom === 'string' && item.custom.trim() !== '',
        'human question answer must carry a non-empty custom answer',
        'TEAM_HUMAN_QUESTIONS_INVALID_ANSWER',
      )
      return item.custom
    },
  }
}
