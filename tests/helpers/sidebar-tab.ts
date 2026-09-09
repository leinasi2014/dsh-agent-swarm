import type { SidebarRightTabInfo } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'

/** A stable public hook value; hide does not abort its record. */
export function tabInfoFixture(id = 'tab-3', close: () => void = () => {}): SidebarRightTabInfo {
  return { sidebar: { expanded: true, fullscreen: false }, panel: { id: 'pane-1' },
    tab: { id, kind: 'swarm-team', contentId: 'dsh-page://swarm-team', title: 'Team', visible: true,
      navigation: { address: 'dsh-page://swarm-team', params: undefined, revision: 1 }, signal: new AbortController().signal,
      actions: { close, openTab: () => {}, openResource: () => {} } } }
}
const tabInfo = tabInfoFixture()
export const useTabInfo = (): SidebarRightTabInfo => tabInfo
