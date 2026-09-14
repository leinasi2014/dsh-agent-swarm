/**
 * M3 evidence segment (task-10): the Host-side RESULT witness. Given the
 * caller's CURRENT live official Session and a model-cited call id, this
 * returns the bounded witness core of the EXACT tool call the member actually
 * performed — or rejects.
 *
 * Boundary rules (public official facts only):
 * - Only the session's OWN window is searched: `session.inheritedEventCount`
 *   is the durable fork-lineage cut, and `snapshotEvents(fromSeq)` is the
 *   public window read. Events inherited from a fork parent (e.g. a Captain's
 *   calls present in a forked session's prefix) are NEVER own results.
 * - The callId must pair EXACTLY ONE `tool/call` with EXACTLY ONE
 *   `tool/result` (`message.source.callId`) in that window; zero occurrences
 *   reject as unknown, more than one pairing is ambiguous and rejects rather
 *   than guessing.
 * - What is witnessed is only that the tool really returned this result:
 *   the actual tool name, the exact log coordinates, the result's own
 *   `isError` identity, and a bounded SHA-256 digest of the result content
 *   (never the raw output). It witnesses NO technical conclusion.
 *
 * The live-Agent/registry/Team authority stays at the tool and service call
 * sites; this module is pure log-reading and is separately provable against
 * official forked sessions.
 *
 * @module dsh-agent-swarm/runtime/member-private-memory-witness
 */
import { createHash } from 'node:crypto'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { PrivateMemoryObservationCore } from '../storage/member-private-memory-claim.js'

/** Rejects with the reason only — never call content. */
export type WitnessReject = (reason: string) => never

function digestOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')
}

/** Witness the unique own-window call/result pair behind `callId`. */
export function witnessObservation(
  session: Session,
  callId: string,
  reject: WitnessReject,
): PrivateMemoryObservationCore {
  // Own window only: the durable fork-inherited prefix is excluded through
  // the public boundary — a parent's calls can never be laundered into an
  // "own result" by scanning full history.
  const events = session.snapshotEvents(session.inheritedEventCount)
  // Official SessionEventMap projections (exact event-shape narrowing).
  type CallEvent = Extract<SessionEvent, { type: 'tool/call' }>
  type ResultEvent = Extract<SessionEvent, { type: 'tool/result' }>
  const calls = events.filter((event): event is CallEvent =>
    event.type === 'tool/call' && event.data.callId === callId)
  const results = events.filter((event): event is ResultEvent =>
    event.type === 'tool/result' && event.data.message.source.callId === callId)
  if (calls.length === 0 || results.length === 0) reject(`no tool/call+tool/result pair for call '${callId}' in the caller's own session window`)
  if (calls.length !== 1 || results.length !== 1) {
    reject(`call '${callId}' has ${calls.length} calls and ${results.length} results in the own window; ambiguous witnesses reject`)
  }
  const call = calls[0]!
  const result = results[0]!
  // Exact coordinates: the pair must be the SAME official call site
  // (turn/step) with the result strictly after the call — two unrelated
  // single occurrences under one reused callId never splice into a pair.
  if (call.data.turn !== result.data.turn || call.data.step !== result.data.step || result.seq <= call.seq) {
    reject(`call '${callId}' does not form a single coherent call/result pair in the own window`)
  }
  const tool = call.data.name
  const content = result.data.message.content
  const isError = content.some(block => block.type === 'tool-result' && block.isError === true)
  // The official optional error{name,code} identity (allowed only with
  // isError) is COVERED by the bounded digest — the witnessed failure is
  // identifiable as its real tool-layer error identity, never raw output.
  const error = result.data.error ?? null
  return {
    tool,
    callId,
    callSeq: call.seq,
    resultSeq: result.seq,
    isError,
    resultDigest: digestOf([content, error]),
  }
}
