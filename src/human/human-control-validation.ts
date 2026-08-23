import { Buffer } from 'node:buffer'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { TeamDomainError } from '../domain/error.js'
import type { TeamScope } from '../domain/team-domain-port.js'
import type { ToolExecutionAuthority } from '../runtime/authority.js'
import {
  HUMAN_INTERACTION_CONTROL_INTENTS,
  type HumanInteractionRequest,
} from './human-interaction-contract.js'
import { parseHumanInteractionRequestRecord } from './human-interaction-store.js'

const MAX_HUMAN_DIAGNOSTIC_BYTES = 2_048
const MAX_PRINCIPAL_BYTES = 256
const MAX_SCOPE_BYTES = 4_096

export type HumanControlAdmission =
  | { readonly kind: 'captain'; readonly exec: ToolExecutionAuthority }
  | { readonly kind: 'authenticated-human'; readonly principalRef: string }

function invalid(message = 'human interaction input is invalid'): TeamDomainError {
  return new TeamDomainError(message, 'TEAM_INTERACTION_INVALID')
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    || Object.getOwnPropertySymbols(value).length !== 0) throw invalid()
  return value as Record<string, unknown>
}

function exact(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw invalid('human interaction input contains unknown fields')
}

function text(value: unknown, maxBytes: number): string {
  if (typeof value !== 'string' || value === '' || Buffer.byteLength(value, 'utf8') > maxBytes) throw invalid()
  return value
}

/** Strict public parser: exact keys in, fresh normalized request out. */
export function parseHumanControlRequest(value: unknown): HumanInteractionRequest {
  try {
    const parsed = parseHumanInteractionRequestRecord(value)
    if (parsed.origin !== undefined
      || !HUMAN_INTERACTION_CONTROL_INTENTS.includes(parsed.intent as never)) throw invalid()
    if (parsed.expiresAt !== undefined && parsed.expiresAt <= parsed.createdAt) throw invalid()
    if (parsed.intent === 'interrupt-member' || parsed.intent === 'wake-member') {
      if (parsed.target.kind !== 'member' || parsed.expectedTaskRevision !== undefined
        || parsed.attemptId !== undefined || parsed.decision !== undefined) throw invalid()
    } else {
      if (parsed.target.kind !== 'task' || parsed.expectedTaskRevision === undefined || parsed.attemptId === undefined) throw invalid()
      if (parsed.intent === 'review-task') {
        if (parsed.decision !== 'accept' && parsed.decision !== 'reject') throw invalid()
      } else if (parsed.decision !== undefined) throw invalid()
    }
    return parsed
  } catch (error) {
    if (error instanceof TeamDomainError) throw error
    throw invalid()
  }
}

/** Strict admission parser: exact discriminant keys and a fresh envelope. */
export function parseHumanControlAdmission(value: unknown): HumanControlAdmission {
  try {
    const admission = record(value)
    if (admission.kind === 'authenticated-human') {
      exact(admission, ['kind', 'principalRef'])
      return { kind: 'authenticated-human', principalRef: text(admission.principalRef, MAX_PRINCIPAL_BYTES) }
    }
    if (admission.kind !== 'captain') throw invalid()
    exact(admission, ['kind', 'exec'])
    const exec = record(admission.exec)
    exact(exec, ['agent', 'signal'])
    const agent = exec.agent
    const signal = exec.signal
    if (typeof agent !== 'object' || agent === null || typeof (agent as Agent).id !== 'string'
      || typeof signal !== 'object' || signal === null || typeof (signal as AbortSignal).aborted !== 'boolean') throw invalid()
    return { kind: 'captain', exec: { agent: agent as Agent, signal: signal as AbortSignal } }
  } catch (error) {
    if (error instanceof TeamDomainError) throw error
    throw invalid()
  }
}

export function parseHumanControlScope(value: unknown): TeamScope {
  return text(value, MAX_SCOPE_BYTES)
}

export function parseHumanControlSignal(value: unknown): AbortSignal {
  if (typeof value !== 'object' || value === null || typeof (value as AbortSignal).aborted !== 'boolean') throw invalid()
  return value as AbortSignal
}

export function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  const parts: string[] = []
  let bytes = 0
  for (const codePoint of value) {
    const size = Buffer.byteLength(codePoint, 'utf8')
    if (bytes + size > maxBytes) break
    parts.push(codePoint)
    bytes += size
  }
  return parts.join('')
}

export function parseCancelDiagnostic(value: unknown): string {
  if (typeof value !== 'string') throw invalid()
  return truncateUtf8(value.trim() || 'cancelled by Human Control', MAX_HUMAN_DIAGNOSTIC_BYTES)
}
