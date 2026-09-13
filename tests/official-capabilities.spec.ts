import { describe, expect, it, vi } from 'vitest'
import {
  RESERVED_SIDEBAR_LIST_SLOT,
  TEAM_PANEL_GEOMETRY,
  probePanelGeometry,
  registerSidebarNavigation,
  requestLatestNavigation,
} from '../src/client/official-capabilities.js'

describe('reserved official seams (A-class)', () => {
  it('applies the Team geometry only when an official entry exists', () => {
    expect(probePanelGeometry({})).toBeUndefined()
    expect(probePanelGeometry(undefined)).toBeUndefined()
    const register = vi.fn(() => () => {})
    const seam = probePanelGeometry({ registerPanelPresentation: register })
    expect(seam).toBeTypeOf('function')
    seam!('swarm.group', TEAM_PANEL_GEOMETRY)
    expect(register).toHaveBeenCalledExactlyOnceWith('swarm.group', TEAM_PANEL_GEOMETRY)
  })

  it('keeps the V7 geometry values that a future official entry would receive', () => {
    expect(TEAM_PANEL_GEOMETRY.columns.sidebar).toEqual({ defaultWidth: 166, minWidth: 166 })
    expect(TEAM_PANEL_GEOMETRY.columns.rightbar).toEqual({ defaultWidth: 320 })
    expect(TEAM_PANEL_GEOMETRY.rightSidebar).toBe('current-session')
  })

  it('requests the latest position only when the official service provides it', () => {
    const requestLatest = vi.fn(() => () => {})
    const withService = { get: (name: string) => name === 'chatNavigation' ? { requestLatest } : undefined }
    requestLatestNavigation(withService, 'session-1')
    expect(requestLatest).toHaveBeenCalledExactlyOnceWith('session-1')
    expect(() => requestLatestNavigation({ get: () => undefined }, 'session-2')).not.toThrow()
    expect(() => requestLatestNavigation({ get: () => ({}) }, 'session-3')).not.toThrow()
  })

  it('registers the resident rail only when the official sidebar list region exists', () => {
    const register = vi.fn((_entry: string) => () => {})
    const install = vi.fn((region: string) => register(region))
    // A1 probe-failure is observable: no official region today, so nothing registers.
    expect(registerSidebarNavigation({ register }, install)).toBeUndefined()
    expect(install).not.toHaveBeenCalled()
    // A slot service without a register face is not an official region either.
    expect(registerSidebarNavigation({}, install, 'sidebar.resident')).toBeUndefined()
    expect(registerSidebarNavigation(undefined, install, 'sidebar.resident')).toBeUndefined()
    expect(install).not.toHaveBeenCalled()
    // Once an official region exists, the same entry point installs the rail there.
    const dispose = vi.fn()
    const seam = registerSidebarNavigation({ register }, vi.fn(() => dispose), 'sidebar.resident')
    expect(seam).toBe(dispose)
  })

  it('documents that no official resident sidebar list exists yet', () => {
    expect(RESERVED_SIDEBAR_LIST_SLOT).toBeUndefined()
  })
})
