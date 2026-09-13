import { vi } from 'vitest'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { PublicChatState } from '../../src/client/public-chat-controller.js'
import type { TeamDashboardState } from '../../src/client/team-dashboard-controller.js'
import { t } from './dashboard-ui.js'
import { chatState, teamState } from './public-chat-fixtures.js'

export function chatProps(state = teamState(), chat = chatState(state)) {
  return { t, useSessions: <T,>(selector: (state: SessionListState) => T) => selector({ ids: [], byId: {}, current: chat.selection?.viewer as SessionListState['current'], phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined }), useTeam: <T,>(selector: (state: TeamDashboardState) => T) => selector(state), useChat: <T,>(selector: (state: PublicChatState) => T) => selector(chat),
    useSurface: <T,>(selector: (state: { mode: 'inactive'; view: 'overview'; targetSessionId: undefined }) => T) => selector({ mode: 'inactive', view: 'overview', targetSessionId: undefined }),
    replaceText: vi.fn(), chooseMention: vi.fn(), removeMention: vi.fn(), refreshDirectory: vi.fn(), upgradeLegacy: vi.fn(), send: vi.fn(), recover: vi.fn(), earlier: vi.fn(), newer: vi.fn(), refresh: vi.fn(), latest: vi.fn(), edit: vi.fn(), reply: vi.fn(), openTeam: vi.fn(),
    addImages: vi.fn(), removeImage: vi.fn(), image: vi.fn(async () => new Blob(['image'], { type: 'image/png' })), retryDraftStorage: vi.fn(), useStoredDraft: vi.fn(),
  }
}
