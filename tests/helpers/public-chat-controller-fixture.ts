import { afterAll, beforeAll, expect, vi } from 'vitest'
import { chromium, type Browser, type BrowserContext } from 'playwright'
import { PublicChatController } from '../../src/client/public-chat-controller.js'
import { TeamDashboardController, type TeamDashboardState } from '../../src/client/team-dashboard-controller.js'
import { SwarmReadClient } from '../../src/client/read-client.js'
import type { DirectoryRequest } from '../../src/rpc/directory-contract.js'
import type { PublicChatV3RequestResultResponse, PublicChatRequestResultResponse, PublicChatV3AppendRequest, PublicChatV3HistoryRequest, PublicChatV3HistoryResponse, PublicChatV3Message } from '../../src/rpc/public-rpc-contract.js'
import { directoryPage } from './public-directory.js'
import { browserDraftStore } from './public-draft-browser.js'
import { goodFetch, ManualSchedule, waitFor } from './dashboard-controller.js'

let base: TeamDashboardState
let browser: Browser, draftContext: BrowserContext
beforeAll(async () => {
  browser = await chromium.launch({ channel: 'msedge', headless: true }); draftContext = await browser.newContext()
  const controller = new TeamDashboardController(new SwarmReadClient(goodFetch([])), new ManualSchedule())
  controller.open('root-1'); await waitFor(() => controller.getSnapshot().phase === 'ready')
  base = controller.getSnapshot(); controller.dispose()
}, 30_000)
afterAll(async () => { await browser?.close() }, 30_000)
export function dashboard(team = 'a', revision = 4, viewer = 'viewer'): TeamDashboardState {
  const data = base.data!
  return { ...base, targetSessionId: viewer, data: { ...data,
    teams: { ...data.teams, binding: { rootSessionId: viewer, mainSessionId: 'main' } },
    projection: { ...data.projection, binding: { rootSessionId: `captain-${team}`, teamId: team }, team: { ...data.projection.team, id: team, revision } },
  } }
}
export function message(sequence: number, state: 'queued' | 'claimed' = 'queued'): PublicChatV3Message {
  return { id: `message-${sequence}`, sequence, createdAt: 1000, text: `Text ${sequence}`, formatVersion: 2, content: [{ type: 'text', text: `Text ${sequence}` }], mentionLabels: [], author: { kind: 'local-operator' }, delivery: { kind: 'requested', recipients: [state === 'queued' ? { state, recipientSessionId: 'captain-a' } : { state, recipientSessionId: 'captain-a', claimedAt: 2000 }] } }
}
export function page(team = 'a', entries: readonly PublicChatV3Message[] = [], more = false, revision = 4): PublicChatV3HistoryResponse {
  return { schemaVersion: 3, binding: { rootSessionId: `captain-${team}`, teamId: team }, teamRevision: revision, observedAt: 2000,
    entries, totalCount: entries.length, returnedCount: entries.length, limit: 50, hasEarlier: false, hasMore: more,
    appendEligibility: { state: 'available' }, imageAvailability: { state: 'available', imageLimits: { maxImageBytes: 20_971_520, maxImagesPerMessage: 20, maxMessageImageBytes: 209_715_200, maxImagePixels: 64_000_000, maxImageDimension: 8192, mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] } }, limits: { maxSegments: 256, maxTextBytes: 4096, maxMessages: 1000, maxBytes: 100000 },
    ...(entries[0] === undefined ? {} : { firstSequence: entries[0].sequence, lastSequence: entries.at(-1)!.sequence }),
  }
}
export async function fixture(requestId = () => 'original-id') {
  const databaseName = crypto.randomUUID(), drafts = () => browserDraftStore(draftContext, databaseName)
  const storage = new Map<string, string>()
  const port = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value) } }
  const client = {
    directory: vi.fn(async (request: DirectoryRequest, _signal?: AbortSignal) => directoryPage(request.target.teamId)),
    requestResult: vi.fn(async (): Promise<PublicChatRequestResultResponse> => ({ schemaVersion: 1 as const, binding: { rootSessionId: 'captain-a', teamId: 'a' }, teamRevision: 4, observedAt: 20, state: 'not-found' as const })),
    historyV3: vi.fn(async (request: PublicChatV3HistoryRequest) => page(request.target.teamId)),
    appendV3: vi.fn(async (request: PublicChatV3AppendRequest) => ({ ...page(request.target.teamId), message: message(1), replayed: false })),
    requestResultV3: vi.fn(async (_request: unknown, _signal?: AbortSignal): Promise<PublicChatV3RequestResultResponse> => ({ ...page(), state: 'not-found' as const })),
    requestResultV2: vi.fn(async (): Promise<import('../../src/rpc/public-rpc-contract.js').PublicChatV2RequestResultResponse> => ({ schemaVersion: 2, binding: page().binding, teamRevision: 4, observedAt: 20, state: 'not-found' })),
    appendV2: vi.fn(async (): Promise<import('../../src/rpc/public-rpc-contract.js').PublicChatV2AppendResponse> => ({ schemaVersion: 2, binding: page().binding, teamRevision: 4, observedAt: 20, replayed: false, message: { ...message(1), formatVersion: 2, content: [{ type: 'text', text: 'legacy v2' }], author: { kind: 'local-operator' }, delivery: { kind: 'not-requested' } } })),
    image: vi.fn(async (): Promise<import('../../src/rpc/public-rpc-contract.js').PublicChatV3ImageResponse> => ({ ...page(), messageId: 'message-1', imageId: 'image-1', image: { mediaType: 'image/png', data: 'YWJj', bytes: 3, width: 1, height: 1 } })),
  }
  const draftStore = await drafts()
  const controller = new PublicChatController(client, 'http://host:3094', port, requestId, draftStore, async (_blob, image) => ({ ...image, status: 'ready', width: 1, height: 1 }))
  return { controller, client, port, storage, drafts, draftStore }
}
export async function ready(controller: PublicChatController, state = dashboard()): Promise<void> {
  controller.bind(state); await vi.waitFor(() => { expect(controller.getSnapshot().loading).toBe(false); expect(controller.getSnapshot().draftStatus).not.toBe('loading') }, { timeout: 5000 })
}

