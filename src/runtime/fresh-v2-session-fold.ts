import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { canonicalV2Digest } from '../protocol/canonical-v2.js'
import { TeamDomainError } from '../domain/error.js'
import { currentOpenStepStartSeq } from './fresh-v2-session-step.js'

export interface ClaimedInitialFrame {
  readonly turn: number
  readonly step: number
  readonly stepStartSeq: number
  readonly messageSeq: number
  readonly messageId: string
  readonly initialPromptDigest: string
}

/** Stable digest of the exact one-text-block assignment frame. */
export function initialPromptDigest(text: string): string {
  return canonicalV2Digest('dsh-agent-swarm/a1b/initial-prompt/v1', { text })
}

function promptText(event: SessionEvent): string | undefined {
  if (event.type !== 'user/message' || event.data.source.kind !== 'user'
    || event.data.content.length !== 1) return undefined
  const block = event.data.content[0]
  return block?.type === 'text' ? block.text : undefined
}

/** Detect an initial assignment in one open current step after its Team Attempt lost authority. */
export function currentStepContainsInitialFrame(
  session: Session,
  turn: number,
  step: number,
  expectedPromptDigest: string,
): boolean {
  const startSeq = currentOpenStepStartSeq(session, turn, step)
  if (startSeq === undefined) return false
  return session.events.some(event => {
    if (event.seq <= startSeq) return false
    const text = promptText(event)
    return text !== undefined && initialPromptDigest(text) === expectedPromptDigest
  })
}

/** Fold one exact still-open AgentLoop step and its unique assignment frame. */
export function claimedInitialFrame(
  session: Session,
  turn: number,
  step: number,
  expectedPromptDigest: string,
): ClaimedInitialFrame {
  const starts = session.events.filter(event => event.type === 'step/start'
    && event.data.turn === turn && event.data.step === step)
  if (starts.length !== 1) {
    throw new TeamDomainError('current initial-assignment step is missing or ambiguous', 'TEAM_ASSIGNMENT_NOT_CLAIMED')
  }
  const start = starts[0]!
  if (session.events.some(event => event.seq > start.seq && event.type === 'step/end'
    && event.data.turn === turn && event.data.step === step)) {
    throw new TeamDomainError('initial-assignment step is already closed', 'TEAM_ASSIGNMENT_NOT_CLAIMED')
  }
  const matches = session.events.flatMap(event => {
    if (event.seq <= start.seq) return []
    const text = promptText(event)
    if (text === undefined || initialPromptDigest(text) !== expectedPromptDigest) return []
    return [{ event, text }]
  })
  if (matches.length !== 1) {
    throw new TeamDomainError('current step does not contain one exact initial-assignment frame', 'TEAM_ASSIGNMENT_NOT_CLAIMED')
  }
  const match = matches[0]!
  if (match.event.type !== 'user/message') {
    throw new TeamDomainError('initial-assignment frame is not a user message', 'TEAM_ASSIGNMENT_NOT_CLAIMED')
  }
  return {
    turn,
    step,
    stepStartSeq: start.seq,
    messageSeq: match.event.seq,
    messageId: match.event.data.id,
    initialPromptDigest: initialPromptDigest(match.text),
  }
}

/** Require one exact assistant event to exist in the immutable Session log. */
export function assistantEvidenceAt(
  session: Session,
  eventSeq: number,
  eventType: 'assistant/message',
  turn: number,
  step: number,
): void {
  const event = session.events[eventSeq]
  if (event === undefined || event.seq !== eventSeq || event.type !== eventType
    || event.data.turn !== turn || event.data.step !== step) {
    throw new TeamDomainError('assistant evidence does not match the entered dispatch', 'TEAM_ATTEMPT_STALE')
  }
}
