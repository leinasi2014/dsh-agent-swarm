import { ready } from './dashboard-ui.js'
import type { PublicChatState } from '../../src/client/public-chat-controller.js'
import type { TeamDashboardState } from '../../src/client/team-dashboard-controller.js'

// Shared browser-safe composition fixtures (extracted verbatim from public-chat-ui.spec.tsx so real-mount specs reuse one source).
export function teamState(): TeamDashboardState {
  const data = ready.data!
  const a = data.teams.teams[0]!
  return { ...ready, data: { ...data,
    projection: { ...data.projection, roster: [{ ...data.projection.roster[0]!, name: 'writer', phase: 'active' }] },
    teams: { ...data.teams, teams: [a, { ...a, teamId: 'b', name: 'Team B', captainSessionId: 'captain-b' }] },
    captainMembers: { ...data.captainMembers, members: [{ ...data.captainMembers.members[0]!, name: 'writer', displayName: 'Lin', phase: 'active', sessionId: 'member-1' }] },
  } }
}
export function chatState(state: TeamDashboardState): PublicChatState {
  const binding = state.data!.projection.binding
  const selection = { key: 'draft-key', viewer: state.targetSessionId!, captain: binding.rootSessionId, team: binding.teamId, revision: state.data!.projection.team.revision }
  const entries = [{ id: 'public-1', sequence: 1, createdAt: 1000, author: { kind: 'local-operator' as const }, text: '真实消息', formatVersion: 2 as const, content: [{ type: 'text' as const, text: '真实消息' }], mentionLabels: [], delivery: { kind: 'requested' as const, recipients: [{ state: 'claimed' as const, claimedAt: 2000, recipientSessionId: binding.rootSessionId }] } }]
  return { selection, entries, draft: { text: 'send me', version: 1, tokens: [] }, sending: false, loading: false, pending: false, error: undefined, directory: undefined, directoryError: undefined, directoryLoading: false, legacyUpgrade: false, draftStatus: 'ready', draftBlobs: {},
    history: { schemaVersion: 3, binding, observedAt: 2000, teamRevision: selection.revision, entries, totalCount: 1, returnedCount: 1, limit: 50, hasEarlier: false, hasMore: false, firstSequence: 1, lastSequence: 1, appendEligibility: { state: 'available' }, limits: { maxSegments: 256, maxTextBytes: 4096, maxBytes: 100000, maxMessages: 1000 }, imageAvailability: { state: 'available', imageLimits: { maxImageBytes: 2000, maxImagesPerMessage: 20, maxMessageImageBytes: 20000, maxImagePixels: 10000, maxImageDimension: 1000, mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] } } },
  }
}
