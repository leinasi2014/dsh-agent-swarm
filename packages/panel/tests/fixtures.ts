import type { SwarmPanelSnapshot } from '../src/types.ts'
import { zh, type SwarmStrings } from '../src/strings.ts'

/** The canonical zh dictionary: tests assert against its resolved copy. */
export const strings: SwarmStrings = zh

/** A full canonical snapshot: every S1 segment present. */
export function makeSnapshot(): SwarmPanelSnapshot {
  return {
    team: { id: 'team-1', name: 'demo-team', revision: 3 },
    members: [
      { id: 'm-lead', role: 'lead', phase: 'active' },
      { id: 'm-worker', role: 'worker', phase: 'active' },
      { id: 'm-idle', role: 'worker', phase: 'idle' },
    ],
    tasks: [
      { id: 't-1', title: 'wire contracts', status: 'in_progress', ownerId: 'm-lead', attempts: 1 },
      { id: 't-2', title: 'write docs', status: 'pending', attempts: 0, blockedBy: ['t-1', 't-9'] },
      { id: 't-3', title: 'land release', status: 'completed', ownerId: 'm-worker', attempts: 2 },
    ],
    counters: { total: 3, completed: 1, ready: 1, queuedMessages: 2, memoryEntries: 4 },
    budget: { usedTokens: 1234, usedRequests: 12, usedRetries: 1, observedAt: '2026-08-22T00:00:00.000Z' },
    review: [{ requestId: 'r-1', state: 'pending', summary: 'promote candidate' }],
  }
}

/** The degraded Canvas MVP shape: counters + budget, no roster and no task rows. */
export function makeDegradedSnapshot(): SwarmPanelSnapshot {
  const base = makeSnapshot()
  const budget = base.budget
  if (budget === undefined) throw new Error('fixture budget is always present')
  return { team: base.team, counters: base.counters, budget }
}
