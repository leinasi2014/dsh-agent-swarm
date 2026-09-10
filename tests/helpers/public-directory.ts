import type { DirectoryEntry, DirectoryResponse, DirectorySource } from '../../src/rpc/directory-contract.js'
const source: DirectorySource = { state: 'available', source: 'test-authority', version: 'v1', observedAt: 20, updatedAt: 10 }
export function directoryEntry(memberId = 'member-a', label = '同舟'): DirectoryEntry {
  return { memberId, label, name: memberId, responsibility: '核对文字', role: 'member', phase: 'active', profile: source, avatar: { state: 'not_generated', reason: 'avatar_backend_not_implemented' },
    profession: '校对员', personality: '严谨', biography: '公开简介', currentTasks: [],
    skills: { assigned: { ...source, entries: [{ name: 'review', description: '核对原文' }] }, sessionVisible: { ...source, entries: [] }, catalog: { ...source, entries: [] } },
    tools: { ...source, complete: false, entries: [{ name: 'read', state: 'approval-required', teamPolicy: 'ask' }] },
    model: { ...source, provider: 'official', model: 'reader', imageInput: 'unknown' },
  }
}
export function directoryPage(team = 'a', entries = [directoryEntry(), directoryEntry('member-b')], revision = 'directory-v1'): DirectoryResponse {
  return { schemaVersion: 2, binding: { rootSessionId: `captain-${team}`, teamId: team }, directoryRevision: revision, observedAt: 20, entries, page: { offset: 0, limit: 50, totalCount: entries.length, returnedCount: entries.length, hasMore: false, unreadRanges: [] } }
}
