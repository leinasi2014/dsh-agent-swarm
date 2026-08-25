import type { Session } from '@deepseek-ai/dsh-session'

/** Resolve one exact still-open Session step without interpreting its messages. */
export function currentOpenStepStartSeq(session: Session, turn: number, step: number): number | undefined {
  const starts = session.events.filter(event => event.type === 'step/start'
    && event.data.turn === turn && event.data.step === step)
  if (starts.length !== 1) return undefined
  const start = starts[0]!
  if (session.events.some(event => event.seq > start.seq && event.type === 'step/end'
    && event.data.turn === turn && event.data.step === step)) return undefined
  return start.seq
}
