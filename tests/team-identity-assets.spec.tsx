// @vitest-environment jsdom
//
// task-3: identity card + safe pixel SVG avatar (not-generated state).
// Pins the honest-asset contract: deterministic safe pixel avatar, explicit
// not-generated/unavailable placeholder, authoritative name/role verbatim, and
// profession/personality NEVER fabricated — plus zh/en copy. No backend file touched.
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { SafePixelAvatar, pixelPattern } from '../src/client/SafePixelAvatar.js'
import { TeamIdentityCard } from '../src/client/TeamIdentityCard.js'
import { en, TEAM_DASHBOARD_NS, zh } from '../src/client/team-dashboard-locales.js'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mounted: Root[] = []
const interpolate = (template: string, params?: Record<string, unknown>): string => template.replace(/\{(\w+)\}/gu, (match, name: string) => name in (params ?? {}) ? String(params?.[name]) : match)
const lookup = (table: Record<string, string>, key: string): string => table[key as keyof typeof en] ?? String(key)
const t: TranslateNS<typeof TEAM_DASHBOARD_NS> = (key, params) => interpolate(lookup(en as Record<string, string>, key), params)
const tZh: TranslateNS<typeof TEAM_DASHBOARD_NS> = (key, params) => interpolate(lookup(zh as Record<string, string>, key), params)

async function render(node: ReactNode): Promise<void> { const root = createRoot(document.body.appendChild(document.createElement('div'))); mounted.push(root); await act(async () => { root.render(node) }) }
afterEach(async () => { while (mounted.length) await act(async () => { mounted.pop()?.unmount() }); document.body.replaceChildren() })

describe('SafePixelAvatar (task-3)', () => {
  it('derives a deterministic symmetric pixel pattern from the seed and never from the DOM', () => {
    expect(pixelPattern('Alpha 舰队')).toEqual(pixelPattern('Alpha 舰队'))
    expect(pixelPattern('Alpha 舰队')).not.toEqual(pixelPattern('Beta Team'))
    // every row is horizontally symmetric including the shared centre cell
    for (const row of pixelPattern('Alpha 舰队')) expect(row).toEqual(row.toReversed())
  })

  it('renders the honest not_generated state with the real backend reason and a placeholder label', async () => {
    await render(<SafePixelAvatar seed="Alpha 舰队" name="Alpha 舰队" asset={{ state: 'not_generated', reason: 'avatar_backend_not_implemented' }} t={t} />)
    const avatar = document.querySelector<SVGElement>('[data-swarm-pixel-avatar]')!
    expect(avatar).not.toBeNull()
    expect(avatar.getAttribute('data-avatar-state')).toBe('not_generated')
    expect(avatar.getAttribute('data-avatar-reason')).toBe('avatar_backend_not_implemented')
    expect(avatar.getAttribute('aria-label')).toContain('Alpha 舰队')
    expect(avatar.getAttribute('aria-label')).toContain(t('avatarNotGeneratedLabel'))
    // it still draws a deterministic pixel grid — but never claims to be a real generated asset.
    expect(avatar.querySelectorAll('rect').length).toBeGreaterThan(0)
    // the muted placeholder follows the official DSH theme aliases (light/dark), not a hardcoded palette
    expect(avatar.innerHTML).toContain('var(--dsw-alias-label-secondary)')
    expect(avatar.innerHTML).toContain('var(--dsw-alias-bg-layer-1)')
  })

  it('keeps unavailable visually/a11y distinct from not_generated and localizes zh', async () => {
    await render(<SafePixelAvatar seed="甲" name="甲" asset={{ state: 'unavailable' }} t={tZh} />)
    const avatar = document.querySelector<SVGElement>('[data-swarm-pixel-avatar]')!
    expect(avatar.getAttribute('data-avatar-state')).toBe('unavailable')
    expect(avatar.getAttribute('aria-label')).toContain(zh.avatarUnavailableLabel)
  })
})

describe('TeamIdentityCard (task-3)', () => {
  it('shows authoritative name/role verbatim and explicit not-generated profession/personality without fabricating', async () => {
    await render(<TeamIdentityCard name="Alice" role="Team Captain"
      avatar={{ state: 'not_generated', reason: 'avatar_backend_not_implemented' }}
      identityCard={{ state: 'not_generated', reason: 'identity_backend_not_implemented' }} t={t} />)
    const card = document.querySelector<HTMLElement>('[data-swarm-identity-card]')!
    expect(card.getAttribute('data-swarm-identity-state')).toBe('not_generated')
    expect(card.getAttribute('data-swarm-identity-reason')).toBe('identity_backend_not_implemented')
    // authoritative domain fields are real
    expect(card.textContent).toContain('Alice')
    expect(card.textContent).toContain('Team Captain')
    // profile fields are honest placeholders, never invented values
    expect(card.querySelector('[data-swarm-identity-profession]')?.textContent).toBe(t('profileNotGenerated'))
    expect(card.querySelector('[data-swarm-identity-personality]')?.textContent).toBe(t('profileNotGenerated'))
    // the badge reads the honest not-generated state
    expect(card.querySelector('[data-swarm-identity-badge]')?.textContent).toBe(t('profileNotGenerated'))
    expect(card.querySelector('[data-swarm-identity-badge]')?.getAttribute('data-swarm-identity-badge-state')).toBe('not_generated')
    expect(card.querySelector('[data-swarm-identity-unavailable-hint]')).not.toBeNull()
    expect(card.textContent).not.toMatch(/engineer|writer|designer|analyst/i)
  })

  it('renders unavailable state and zh "不可用" placeholders', async () => {
    await render(<TeamIdentityCard name="甲" role="团队队长"
      avatar={{ state: 'unavailable' }} identityCard={{ state: 'unavailable' }} t={tZh} />)
    const card = document.querySelector<HTMLElement>('[data-swarm-identity-card]')!
    expect(card.getAttribute('data-swarm-identity-state')).toBe('unavailable')
    expect(card.querySelector('[data-swarm-identity-profession]')?.textContent).toBe(zh.profileUnavailable)
    expect(card.querySelector('[data-swarm-identity-personality]')?.textContent).toBe(zh.profileUnavailable)
    expect(card.textContent).toContain('甲')
  })

  it('renders generated profile values only when the backend actually generated them', async () => {
    await render(<TeamIdentityCard name="Bob" role="Member"
      avatar={{ state: 'generated' }} identityCard={{ state: 'generated' }}
      profession="Engineer" personality="Calm" t={t} />)
    const card = document.querySelector<HTMLElement>('[data-swarm-identity-card]')!
    expect(card.getAttribute('data-swarm-identity-state')).toBe('generated')
    // The generated badge reads "Generated" (zh: 已生成), never the not-generated marker.
    expect(card.querySelector('[data-swarm-identity-badge]')?.textContent).toBe(t('profileGenerated'))
    expect(card.querySelector('[data-swarm-identity-badge]')?.getAttribute('data-swarm-identity-badge-state')).toBe('generated')
    expect(card.querySelector('[data-swarm-identity-profession]')?.textContent).toBe('Engineer')
    expect(card.querySelector('[data-swarm-identity-personality]')?.textContent).toBe('Calm')
    expect(card.querySelector('[data-swarm-identity-unavailable-hint]')).toBeNull()
  })

  it('localizes the generated badge to zh 已生成', async () => {
    await render(<TeamIdentityCard name="甲" role="团队队长"
      avatar={{ state: 'generated' }} identityCard={{ state: 'generated' }}
      profession="工程师" personality="沉稳" t={tZh} />)
    expect(document.querySelector('[data-swarm-identity-badge]')?.textContent).toBe(zh.profileGenerated)
    expect(document.querySelector('[data-swarm-identity-badge]')?.textContent).toBe('已生成')
  })
})
