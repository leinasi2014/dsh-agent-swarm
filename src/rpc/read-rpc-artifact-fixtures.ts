/** Static values and requests shared by consumers and contract tests. */
import { deepFreezeJson } from '../host/frozen-json.js'
import { SWARM_READ_RPC_PROTOCOL, SWARM_READ_RPC_NAMESPACE } from './read-rpc-contract.js'

const readCapabilities = [
  { capability: 'toolCatalog.read', state: 'available' },
  { capability: 'skillCatalog.read', state: 'available' },
  { capability: 'teams.read', state: 'available' },
  { capability: 'binding.read', state: 'available' }, { capability: 'status.read', state: 'available' },
  { capability: 'snapshot.read', state: 'available' }, { capability: 'page.read', state: 'available' },
  { capability: 'captainMembers.read', state: 'available' },
  { capability: 'captainAnnouncements.read', state: 'available' },
  { capability: 'captainDiagnostics.read', state: 'available' },
  { capability: 'taskDetail.read', state: 'available' },
  { capability: 'message.write', state: 'unavailable', blocker: 'i1b-effect-correlation' },
  { capability: 'control.write', state: 'unavailable', blocker: 'i1b-effect-correlation' },
  { capability: 'effect.cancel', state: 'unavailable', blocker: 'i1b-effect-correlation' },
]
const projectionCapabilities = [
  { capability: 'snapshot.read', state: 'available' },
  { capability: 'receipt.read', state: 'available' },
  { capability: 'message.write', state: 'unavailable', blocker: 'i1b-effect-correlation' },
  { capability: 'control.write', state: 'unavailable', blocker: 'i1b-effect-correlation' },
  { capability: 'effect.cancel', state: 'unavailable', blocker: 'i1b-effect-correlation' },
]
const fixtureCursor = `r1:${'a'.repeat(64)}`
const fixtureBinding = { rootSessionId: 'session-fixture', teamId: 'team-fixture' }
const fixtureTeam = {
  id: 'team-fixture', name: 'Fixture Team', phase: 'active', revision: 7,
  createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_100,
}
const fixtureResultBase = {
  binding: fixtureBinding, team: fixtureTeam, cursor: fixtureCursor, changed: true, resyncRequired: false,
}
const fixtureTotals = { roster: 0, tasks: 0, attempts: 0, pendingInteractions: 0 }
const fixtureTruncated = { roster: false, tasks: false, attempts: false, pendingInteractions: false }
const fixtureBudget = { usedTokens: 12, usedRequests: 2, usedRetries: 0, tokenLimit: 1_000 }

export const SWARM_READ_RPC_FIXTURES_V1 = deepFreezeJson({
  requests: {
    capabilities: { schemaVersion: 1, method: 'capabilities' },
    toolCatalog: { schemaVersion: 1, method: 'toolCatalog', target: { rootSessionId: 'session-fixture' } },
    skillCatalog: { schemaVersion: 1, method: 'skillCatalog', target: { rootSessionId: 'session-fixture' } },
    teams: { schemaVersion: 1, method: 'teams', target: { rootSessionId: 'session-fixture' } },
    captainMembers: { schemaVersion: 1, method: 'captainMembers', target: { rootSessionId: 'session-fixture', teamId: 'team-fixture' } },
    captainAnnouncements: { schemaVersion: 1, method: 'captainAnnouncements', target: { rootSessionId: 'session-fixture', teamId: 'team-fixture' } },
    captainDiagnostics: { schemaVersion: 1, method: 'captainDiagnostics', target: { rootSessionId: 'session-fixture', teamId: 'team-fixture' } },
    taskDetail: { schemaVersion: 1, method: 'taskDetail', target: { rootSessionId: 'session-fixture', teamId: 'team-fixture' }, taskId: 'task-fixture' },
    snapshot: { schemaVersion: 1, method: 'snapshot', target: { rootSessionId: 'session-fixture', teamId: 'team-fixture' } },
    page: {
      schemaVersion: 1, method: 'page', target: { rootSessionId: 'session-fixture' },
      afterCursor: `r1:${'a'.repeat(64)}`, page: { kind: 'tasks', offset: 0, limit: 50 },
    },
  },
  values: {
    taskDetail: {
      schemaVersion: 1, binding: fixtureBinding, state: 'available', taskId: 'task-fixture', teamRevision: 7,
      task: { id: 'task-fixture', revision: 2, subject: 'Verify detail', description: 'Read the actual task.',
        acceptanceCriteria: ['Match the source'], status: 'pending', blockedBy: [], priority: 0, createdAt: 1, updatedAt: 3 },
      attempts: { scope: 'retained', retainedCount: 1, returnedCount: 1, limit: 100, truncated: false,
        entries: [{ id: 'attempt-fixture', taskId: 'task-fixture', generation: 4, memberName: 'worker', phase: 'rejected',
          assignmentPhase: 'delivered', assignmentDeliveredAt: 2, output: 'Recorded result', evidence: ['Recorded reference'],
          diagnostic: 'Check the source again', createdAt: 1, updatedAt: 3 }] },
      observedAt: 1_700_000_000_200,
    },
    capabilities: {
      protocol: SWARM_READ_RPC_PROTOCOL, version: 1, namespace: SWARM_READ_RPC_NAMESPACE,
      trust: { mode: 'local-single-user-target-bound', principalBound: false, listener: 'loopback' },
      capabilities: readCapabilities,
    },
    toolCatalog: { schemaVersion: 1, binding: { rootSessionId: 'session-fixture' }, complete: true, tools: [{ name: 'read', description: 'Read a file.' }], observedAt: 1_700_000_000_200 },
    skillCatalog: {
      schemaVersion: 1,
      binding: { rootSessionId: 'session-fixture' },
      complete: true,
      skills: [{
        name: 'frontend-review', description: 'Review a frontend implementation.',
        whenToUse: 'Use after UI implementation.', modelInvocable: true,
      }],
      observedAt: 1_700_000_000_200,
    },
    teams: {
      schemaVersion: 1, binding: { rootSessionId: 'session-fixture' },
      teams: [{
        teamId: 'team-fixture', name: 'Fixture Team', phase: 'active', captainSessionId: 'session-fixture',
        displayName: 'Fixture Captain', profession: 'Coordinator', personality: 'Steady',
        avatar: { state: 'generated', svg: '<svg viewBox="0 0 16 16"><rect x="0" y="0" width="8" height="8" fill="#2a3"/></svg>' },
        identityCard: { state: 'generated' },
        goal: { state: 'generated', text: 'Deliver the Team UI.' },
        endpoints: {
          members: { method: 'captainMembers', target: { rootSessionId: 'session-fixture', teamId: 'team-fixture' } },
          announcements: { method: 'captainAnnouncements', target: { rootSessionId: 'session-fixture', teamId: 'team-fixture' } },
          diagnostics: { method: 'captainDiagnostics', target: { rootSessionId: 'session-fixture', teamId: 'team-fixture' } },
        },
      }],
      observedAt: 1_700_000_000_200, complete: true,
    },
    captainMembers: {
      schemaVersion: 1, binding: fixtureBinding,
      members: [
        { name: 'worker', role: 'writer', phase: 'active', createdAt: 1_700_000_000_000,
          avatar: { state: 'not_generated', reason: 'avatar_backend_not_implemented' },
          identityCard: { state: 'not_generated', reason: 'identity_backend_not_implemented' },
          growth: { privateMemory: 'private_to_member', skills: 'not_implemented', capability: 'not_implemented' },
          composition: {
            state: 'available', reason: 'available', runtimeProvider: 'spawn',
            llmProvider: 'mock', model: 'worker-model', personaConfigured: true,
            deniedTools: ['agent_swarm_create_managed'],
          } },
        { name: 'artist', role: 'artist', phase: 'active', createdAt: 1_700_000_000_001,
          displayName: 'Pixel Painter', profession: 'Avatar artist', personality: 'Careful, meticulous',
          avatar: { state: 'generated', svg: '<svg viewBox="0 0 16 16"><rect x="0" y="0" width="8" height="8" fill="#2a3"/></svg>' },
          identityCard: { state: 'generated' },
          growth: { privateMemory: 'private_to_member', skills: 'not_implemented', capability: 'not_implemented' },
          // A corrupt child log fails CLOSED into its own row only: the row still
          // renders (identity/roster authority is the Team aggregate) while the
          // composition honestly reports the explicit failure and discloses
          // nothing beyond the recovery fence provider.
          composition: { state: 'invalid', reason: 'descriptor_invalid', runtimeProvider: 'spawn' } },
      ],
      observedAt: 1_700_000_000_200,
    },
    captainAnnouncements: {
      schemaVersion: 1, binding: fixtureBinding,
      state: 'available',
      entries: [{ id: 'ann-00000000-0000-0000-0000-000000000001', text: 'Welcome to the Fixture Team.', createdAt: 1_700_000_000_050 }],
      observedAt: 1_700_000_000_200,
    },
    captainDiagnostics: {
      schemaVersion: 1, binding: fixtureBinding,
      diagnostics: { revision: 7, phase: 'active', taskCount: 3, attemptCount: 1, memberCount: 1, backend: 'team-domain' },
      observedAt: 1_700_000_000_200,
    },
    binding: fixtureResultBase,
    status: {
      ...fixtureResultBase, budget: fixtureBudget, totals: fixtureTotals, truncated: fixtureTruncated,
      capabilities: projectionCapabilities, observedAt: 1_700_000_000_200,
    },
    snapshot: {
      schemaVersion: 1, ...fixtureResultBase, roster: [], tasks: [], attempts: [], budget: fixtureBudget,
      pendingInteractions: [], totals: fixtureTotals, truncated: fixtureTruncated,
      capabilities: projectionCapabilities, observedAt: 1_700_000_000_200,
    },
    page: {
      kind: 'tasks', entries: [], offset: 0, limit: 50, visibleTotal: 0, authoritativeTotal: 0,
      projectionTruncated: false, cursor: fixtureCursor, changed: false,
      resyncRequired: false, observedAt: 1_700_000_000_000,
    },
    failure: {
      schemaVersion: 1, ok: false,
      error: { code: 'SWARM_RPC_TARGET_NOT_LIVE', message: 'Target root Session is not live' },
    },
  },
})
