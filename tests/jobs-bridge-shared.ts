import type { JobSnapshot } from '@deepseek-ai/dsh-jobs'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { expect } from 'vitest'

export const ASSIGNMENT_RE = /Task: (task-[a-z0-9-]+), revision (\d+)\nAttempt capability: (\S+)/

export const META = {
  name: 'jobs-bridge-proof',
  description: 'Prove the job projection agrees with the workflow event face.',
} as const

export function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

export function completedJobRun() {
  return { cancel: () => {}, done: Promise.resolve({ status: 'completed' as const, output: 'official output' }) }
}

/** Official snapshot cross-field contract (dsh-jobs/src/invariant.ts:17-43). */
export function expectOfficialSnapshotShape(snapshot: JobSnapshot): void {
  const id = String(snapshot.id)
  expect(id).toMatch(/^team-task-[1-9][0-9]*$/)
  expect(snapshot.kind).toBe('team-task')
  expect(snapshot.label.length).toBeGreaterThan(0)
  expect(Number.isSafeInteger(snapshot.startedAt)).toBe(true)
  expect(snapshot.startedAt).toBeGreaterThanOrEqual(0)
  expect(snapshot.ownerSession).toBeUndefined()
  const terminal = ['completed', 'killed', 'failed'].includes(snapshot.status)
  expect(terminal).toBe(snapshot.finishedAt !== undefined)
  if (snapshot.finishedAt !== undefined) expect(snapshot.finishedAt).toBeGreaterThanOrEqual(snapshot.startedAt)
}
