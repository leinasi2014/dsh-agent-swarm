// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { tabInfoFixture as sidebarTabInfo } from './helpers/sidebar-tab.js'
import { installedTargetedSidebar } from './helpers/official-sidebar.js'
import { fixture } from './helpers/coordinator-fixture.js'

vi.mock('../src/client/TeamDashboardDetails.js', () => ({ TeamDashboardDetails: () => null }))

// #274 用户导航契约：延续点击（队员/Captain/Main）无条件按“点击发生时源 Session 的右栏开/关状态”决定目标右栏。
// 真官方 controller/store/adopt 装配（installedTargetedSidebar）；不依赖 sidebar-harness 的默认展开。
// RED 基线（root 日志 ui-root-red.log）：T1/T2/T6/T7/T8 红，T3/T4/T5/T9 绿；实现后 9/9 应绿。
describe('#274 continuation-click right-sidebar visibility contract', () => {
  it('#274 T1 expanded source opens a cold Captain target after adoption', async () => {
    const f = fixture(), official = installedTargetedSidebar()
    try {
      f.releaseSidebar()
      official.adopt('root'); official.controller.setExpandedIn('root', true); official.bind('root')
      f.coordinator.bindSidebar(official.controller); f.setReady('team-1', 'root')
      const offRoot = f.coordinator.observeTab('root', sidebarTabInfo().tab)
      official.calls.length = 0
      await f.coordinator.openTeamCaptain('other') // 冷目标：未 adopt，写入必须留待 adopt 后重放。
      expect(official.controller.isExpandedIn('other')).toBeUndefined()
      official.adopt('other')
      f.sessions.setCurrent('other')
      f.setReady('team-1', 'other') // 既有 authoritative read cadence 重放，无新 timer。
      expect(official.controller.isExpandedIn('other')).toBe(true)
      expect(official.calls).toEqual(['other']) // 展开后自然补开 Team 页签
      offRoot()
    } finally { f.destroy(); official.dispose() }
  })

  it('#274 T2 expanded source overrides an adopted collapsed target', async () => {
    const f = fixture(), official = installedTargetedSidebar()
    try {
      f.releaseSidebar()
      official.adopt('root'); official.controller.setExpandedIn('root', true); official.bind('root')
      official.adopt('other'); official.controller.setExpandedIn('other', false) // 曾被默认/手动收起
      f.coordinator.bindSidebar(official.controller); f.setReady('team-1', 'root')
      await f.coordinator.openTeamCaptain('other')
      expect(official.controller.isExpandedIn('other')).toBe(true) // 延续点击无条件按源展开覆盖
    } finally { f.destroy(); official.dispose() }
  })

  it('#274 T3 expanded source keeps an adopted expanded target expanded', async () => {
    const f = fixture(), official = installedTargetedSidebar()
    try {
      f.releaseSidebar()
      official.adopt('root'); official.controller.setExpandedIn('root', true); official.bind('root')
      official.adopt('other'); official.controller.setExpandedIn('other', true)
      f.coordinator.bindSidebar(official.controller); f.setReady('team-1', 'root')
      await f.coordinator.openTeamCaptain('other')
      expect(official.controller.isExpandedIn('other')).toBe(true)
    } finally { f.destroy(); official.dispose() }
  })

  it('#274 T4 collapsed source never auto-expands a cold target and never force-opens its tab', async () => {
    const f = fixture(), official = installedTargetedSidebar()
    try {
      f.releaseSidebar()
      official.adopt('root'); official.bind('root') // adopt 后无记录 = 默认 collapsed
      f.coordinator.bindSidebar(official.controller); f.setReady('team-1', 'root')
      official.calls.length = 0
      await f.coordinator.openTeamCaptain('other')
      official.adopt('other')
      f.sessions.setCurrent('other')
      f.setReady('team-1', 'other')
      expect(official.controller.isExpandedIn('other')).toBe(false)
      expect(official.calls).toEqual([]) // “A hidden tab belongs to the user”：不强制补开
    } finally { f.destroy(); official.dispose() }
  })

  it('#274 T5 collapsed source symmetrically collapses an adopted expanded target', async () => {
    const f = fixture(), official = installedTargetedSidebar()
    try {
      f.releaseSidebar()
      official.adopt('root'); official.bind('root')
      official.adopt('other'); official.controller.setExpandedIn('other', true)
      f.coordinator.bindSidebar(official.controller); f.setReady('team-1', 'root')
      await f.coordinator.openTeamCaptain('other')
      expect(official.controller.isExpandedIn('other')).toBe(false) // 与既有 :438 基线同格语义
    } finally { f.destroy(); official.dispose() }
  })

  it('#274 T6 expanded source opens a cold Main-chat target after adoption', async () => {
    const f = fixture(), official = installedTargetedSidebar()
    try {
      f.releaseSidebar()
      official.adopt('root'); official.controller.setExpandedIn('root', true); official.bind('root')
      f.coordinator.bindSidebar(official.controller); f.setReady('team-1', 'root')
      const offRoot = f.coordinator.observeTab('root', sidebarTabInfo().tab)
      Object.assign(f.controller, { openMainChat: vi.fn(async (navigate: (id: string, signal: AbortSignal) => void) => { navigate('other', new AbortController().signal) }) })
      official.calls.length = 0
      await f.coordinator.openMainChat() // byId.other 为 root-list 行（非 subagent）
      official.adopt('other')
      f.sessions.setCurrent('other')
      f.setReady('team-1', 'other')
      expect(official.controller.isExpandedIn('other')).toBe(true)
      expect(official.calls).toEqual(['other'])
      offRoot()
    } finally { f.destroy(); official.dispose() }
  })

  it('#274 T7 expanded source opens a cold member chat after adoption', async () => {
    const f = fixture(), official = installedTargetedSidebar()
    try {
      f.releaseSidebar()
      official.adopt('root'); official.controller.setExpandedIn('root', true); official.bind('root')
      f.coordinator.bindSidebar(official.controller); f.setReady('team-1', 'root')
      const offRoot = f.coordinator.observeTab('root', sidebarTabInfo().tab)
      const snapshot = f.sessions.list.getSnapshot
      Object.assign(f.sessions.list, { getSnapshot: () => ({ ...snapshot(), byId: { ...snapshot().byId, member: { origin: 'subagent', parentId: 'captain' } }, subagentsByParent: { captain: { state: 'ready', entries: [{ id: 'member', kind: 'child', mode: 'continuable' }] } } }) })
      const openSubagent = vi.fn()
      Object.assign(f.sessions, { refreshSubagents: vi.fn(async () => {}), openSubagent })
      Object.assign(f.controller, { openMemberChat: vi.fn(async (_name: string, sessionId: string, navigate: (captainId: string, memberId: string, signal: AbortSignal) => Promise<void>) => {
        await navigate('captain', sessionId, new AbortController().signal)
      }) })
      official.calls.length = 0
      await f.coordinator.openMemberChat('m', 'member') // TeamGroupNavigation.tsx:82 同一入口
      expect(openSubagent).toHaveBeenCalledWith({ parentSessionId: 'captain', childSessionId: 'member', mode: 'continuable' })
      official.adopt('member')
      f.sessions.setCurrent('member')
      f.setReady('team-1', 'member')
      expect(official.controller.isExpandedIn('member')).toBe(true)
      expect(official.calls).toEqual(['member'])
      offRoot()
    } finally { f.destroy(); official.dispose() }
  })

  it('#274 T8 manual toggle and closeAndRestoreFocus keep working after continuation arrival', async () => {
    const f = fixture(), official = installedTargetedSidebar()
    try {
      f.releaseSidebar()
      official.adopt('root'); official.controller.setExpandedIn('root', true); official.bind('root')
      f.coordinator.bindSidebar(official.controller); f.setReady('team-1', 'root')
      const offRoot = f.coordinator.observeTab('root', sidebarTabInfo().tab)
      official.calls.length = 0 // 展开 root 的 reveal 补开与本次契约无关，清零后只观察目标路径
      await f.coordinator.openTeamCaptain('other')
      official.adopt('other')
      f.sessions.setCurrent('other')
      f.setReady('team-1', 'other')
      const offOther = f.coordinator.observeTab('other', sidebarTabInfo('other-tab').tab)
      expect(f.coordinator.getSnapshot()).toMatchObject({ mode: 'docked', targetSessionId: 'other' })
      f.coordinator.closeAndRestoreFocus()
      expect(f.coordinator.getSnapshot().mode).toBe('inactive')
      f.coordinator.toggle('other')
      expect(official.controller.isExpandedIn('other')).toBe(true) // 用户手势路径不被继承逻辑破坏
      expect(official.calls).toEqual(['other', 'other']) // 到达补开一次 + 用户重开一次
      offOther(); offRoot()
    } finally { f.destroy(); official.dispose() }
  })

  it('#274 T9 failed handoff leaves no stale inheritance and the next click recomputes from the fresh source', async () => {
    const f = fixture(), official = installedTargetedSidebar()
    try {
      f.releaseSidebar()
      official.adopt('root'); official.controller.setExpandedIn('root', true); official.bind('root')
      f.coordinator.bindSidebar(official.controller); f.setReady('team-1', 'root')
      f.sessions.open.mockImplementation(() => { throw new Error('official open failed') })
      await expect(f.coordinator.openTeamCaptain('other')).rejects.toThrow('official open failed')
      official.adopt('other') // 失败后用户把源收起，再经其他路径进入目标：不得有 stale 展开生效
      official.controller.setExpandedIn('root', false)
      f.sessions.open.mockImplementation(() => {})
      await f.coordinator.openTeamCaptain('other')
      expect(official.controller.isExpandedIn('other')).toBe(false)
    } finally { f.destroy(); official.dispose() }
  })

  // root 反例（public-d0251074）：pending 不得在导航被取代后借普通访问复活。
  it('#274 T10 superseded navigation drops the pending expansion before an ordinary visit', async () => {
    const f = fixture(), official = installedTargetedSidebar()
    try {
      f.releaseSidebar()
      official.adopt('root'); official.controller.setExpandedIn('root', true); official.bind('root')
      f.coordinator.bindSidebar(official.controller); f.setReady('team-1', 'root')
      await f.coordinator.openTeamCaptain('other') // 冷目标 other 留下 pending(expanded=true)
      f.sessions.setCurrent('b') // 用户经官方入口离开去 B：导航被取代
      official.adopt('other')
      f.sessions.setCurrent('other') // 稍后普通 Session 列表访问 other —— 非延续点击
      f.setReady('team-1', 'other')
      expect(official.controller.isExpandedIn('other')).toBe(false) // 不得强制展开，尊重 other 自身状态
      expect(official.calls).not.toContain('other') // 也不得借旧 pending 补开 Team 页签
    } finally { f.destroy(); official.dispose() }
  })
})
