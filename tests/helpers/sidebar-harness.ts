import { vi } from 'vitest'
import type { ISidebarRight, SidebarRightNavigator, SidebarRightTabInfo } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { TeamDashboardSurfaceCoordinator } from '../../src/client/team-dashboard-surface-coordinator.js'
import { tabInfoFixture } from './sidebar-tab.js'

/** Models the official contract: per-Session IDs, body unmount on hide, abort only on removal. */
export function sidebarHarness(coordinator: TeamDashboardSurfaceCoordinator, current: () => string, onOpen: () => void = () => {}) {
  const records = new Map<string, SidebarRightTabInfo>()
  const aborts = new Map<string, AbortController>()
  const mounted = new Map<string, () => void>()
  let expanded = true
  const expansion = new Map<string, boolean>()
  let autoMount = true
  const hide = (id = current()) => { mounted.get(id)?.(); mounted.delete(id) }
  const show = (id = current()) => {
    const info = records.get(id)
    if (info === undefined) return
    hide(id)
    mounted.set(id, coordinator.observeTab(id, info.tab))
  }
  const remove = (id = current()) => {
    hide(id); records.delete(id); aborts.get(id)?.abort(); aborts.delete(id)
  }
  const openTabIn = vi.fn((id: string) => {
    if (!records.has(id)) {
      const abort = new AbortController()
      const info = tabInfoFixture('tab-3', () => { remove(id) })
      records.set(id, { ...info, tab: { ...info.tab, signal: abort.signal } })
      aborts.set(id, abort)
    }
    expanded = true
    expansion.set(id, true)
    onOpen()
    if (autoMount) show(id)
  })
  const openTab = vi.fn(() => { openTabIn(current()) })
  const sidebar: ISidebarRight & Pick<SidebarRightNavigator, 'openTabIn'> = { openTab, openTabIn, openResource: () => { hide() }, close: () => { remove() },
    active: () => records.get(current())?.tab, isExpanded: () => expanded,
    isExpandedIn: id => expansion.get(id) ?? true,
    setExpandedIn: (id, value) => { expansion.set(id, value); if (id === current()) { expanded = value; if (value) show(id); else hide(id) } },
    toggleExpanded: () => { expanded = !expanded; expansion.set(current(), expanded); if (expanded) show(); else hide() },
    focus: () => { show() }, split: () => undefined, float: () => {}, dock: () => {} }
  return { sidebar, openTab, openTabIn, records, hide, show, remove,
    setAutoMount: (value: boolean) => { autoMount = value },
    dispose: () => { for (const id of records.keys()) remove(id) } }
}
