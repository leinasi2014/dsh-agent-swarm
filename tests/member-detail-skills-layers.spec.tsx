import { describe, expect, it, vi } from 'vitest'
import { renderToString } from 'react-dom/server'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SwarmReadCaptainMembersV1 } from '../src/rpc/read-rpc-contract.js'
import { TEAM_DASHBOARD_NS } from '../src/client/team-dashboard-locales.js'
import { MemberDetail } from '../src/client/TeamDashboardContent.js'

// The client-ui-primitives package (and SafePixelAvatar) import node_modules `*.css`
// that Vitest cannot load; stub the UI components so the member-detail render can be
// asserted without the client bundling pipeline.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: () => null, IconCloseOutline16: () => null, StateDot: () => null,
}))
vi.mock('../src/client/SafePixelAvatar.js', () => ({ SafePixelAvatar: () => null }))

/** Minimal member projection with the three Skill layers under test. */
function members(partial: Partial<NonNullable<SwarmReadCaptainMembersV1>> = {}): SwarmReadCaptainMembersV1 {
  return {
    schemaVersion: 1, binding: { rootSessionId: 'r', teamId: 't' }, observedAt: 1,
    members: [{
      name: 'worker', role: 'worker', phase: 'active', createdAt: 1,
      avatar: { state: 'not_generated' }, identityCard: { state: 'not_generated' },
      growth: { privateMemory: 'private_to_member', skills: 'not_implemented', capability: 'not_implemented' },
      skills: ['alpha', 'beta', 'gamma'],
      assignedSkills: ['alpha'],
    }],
    ...partial,
  } as SwarmReadCaptainMembersV1
}

const data = { roster: [{ name: 'worker', role: 'worker', phase: 'active' }], tasks: [], attempts: [] } as never
const localeTag = (() => 'en-US') as () => 'zh-CN' | 'en-US'
const t = ((key: string) => key) as unknown as TranslateNS<typeof TEAM_DASHBOARD_NS>

function render(memberAssets: SwarmReadCaptainMembersV1 | undefined, name = 'worker'): HTMLDivElement {
  const element = document.createElement('div')
  element.innerHTML = renderToString(<MemberDetail detail={{ kind: 'member', name }} data={data} localeTag={localeTag} memberAssets={memberAssets} t={t} />)
  return element
}

describe('A5 member-detail three-layer Skill projection (issue #184)', () => {
  it('renders Team allowed / Session-visible catalog / Member assigned as three distinct labelled values', () => {
    const html = render(members({ teamAllowedSkills: ['alpha', 'beta'] }))
    // Team allowed renders the allow-list; catalog renders the Session-visible set;
    // Member assigned renders the persisted subset — three DIFFERENT values.
    expect(html.querySelector('[data-swarm-detail-team-allowed]')?.textContent).toBe('alpha, beta')
    expect(html.querySelector('[data-swarm-detail-skills-value]')?.textContent).toBe('alpha, beta, gamma')
    expect(html.querySelector('[data-swarm-detail-assigned-skills]')?.textContent).toBe('alpha')
  })

  it('distinguishes an explicit empty assigned subset from an undeclared (undefined) one', () => {
    // Explicit [] -> rendered as the none marker (a declared narrowing).
    const empty = render(members({ teamAllowedSkills: ['alpha'], members: [{
      ...members().members[0]!,
      skills: ['alpha'], assignedSkills: [],
    }] }))
    expect(empty.querySelector('[data-swarm-detail-assigned-skills]')?.textContent).toBe('detail.field.none')
    // Undefined (no team policy / no assigned subset) -> unavailable marker, never conflated.
    const { skills: _skills, assignedSkills: _assignedSkills, ...undeclared } = members().members[0]!
    const undef = render(members({ members: [undeclared] }))
    expect(undef.querySelector('[data-swarm-detail-assigned-skills]')?.textContent).toBe('detail.unavailable')
    expect(undef.querySelector('[data-swarm-detail-team-allowed]')?.textContent).toBe('detail.unavailable')
  })
})
// @vitest-environment jsdom
