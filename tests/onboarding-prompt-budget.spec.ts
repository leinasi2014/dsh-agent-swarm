/**
 * Issue #185 — identity onboarding is progressive and non-blocking, and
 * always-on model context is kept small and role-separated:
 *
 * BEFORE (measured at d0b6adf on this lane):
 *   AGENT_SWARM_USAGE_PROMPT 3448 utf8 bytes (includes Captain-only steps)
 *   captainPersona 1498 bytes (mandatory Chinese display name + SVG avatar)
 *   captainStartNotice 1047 bytes (mandatory profile before recruitment)
 *   add_member tool description 884 bytes (full pixel-SVG grammar)
 *
 * The deterministic budgets below pin the AFTER state plus slack and forbid
 * the Captain-only / SVG-grammar text from the globally mounted sections, so
 * the cost reduction is proven by bytes, not by wall-clock timing.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { captainPersona, captainStartNotice, memberPersona } from '../src/runtime/prompts.js'
import { AGENT_SWARM_USAGE_PROMPT } from '../src/runtime/usage-prompt.js'
import type { TeamState } from '../src/domain/types.js'

const team = { id: 'team-1', name: 'Team', description: 'Goal.' } as unknown as TeamState

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

/** Deterministic token estimate (4 bytes per token, the documented estimate basis). */
function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(utf8Bytes(value) / 4))
}

describe('role-separated always-on prompt cost (issue #185)', () => {
  it('keeps the global usage trigger small, role-neutral and free of Captain-only steps', () => {
    const prompt = AGENT_SWARM_USAGE_PROMPT
    expect(utf8Bytes(prompt)).toBeLessThanOrEqual(1_800)
    for (const captainOnly of [
      'agent_swarm_create_managed',
      'agent_swarm_add_member',
      'agent_swarm_interrupt_member',
      'agent_swarm_wait',
      'recruit',
    ]) {
      expect(prompt).not.toContain(captainOnly)
    }
    expect(estimateTokens(prompt)).toBeGreaterThan(0)
  })

  it('makes identity onboarding progressive: language follows the user, avatar is optional and non-blocking', () => {
    const persona = captainPersona(team)
    const notice = captainStartNotice(team)
    // No forced language.
    expect(persona).not.toContain('Chinese')
    expect(notice).not.toContain('Chinese')
    // Avatar is optional / non-blocking.
    expect(persona).toMatch(/avatar is optional/i)
    expect(notice).toMatch(/avatar/i)
    expect(notice).toMatch(/optional/i)
    // Profile commit stays the documented first Captain action.
    expect(notice.indexOf('agent_swarm_set_captain_profile')).toBeGreaterThanOrEqual(0)
    expect(notice.indexOf('agent_swarm_set_captain_profile')).toBeLessThan(notice.indexOf('agent_swarm_add_member'))
    // No SVG construction grammar in the model-visible identity text.
    for (const grammar of ['<svg', 'viewBox', '<rect', '#RGB', '#RRGGBB']) {
      expect(persona).not.toContain(grammar)
      expect(notice).not.toContain(grammar)
    }
    expect(utf8Bytes(persona)).toBeLessThanOrEqual(1_300)
    expect(utf8Bytes(notice)).toBeLessThanOrEqual(1_300)
  })

  it('keeps the member persona under its byte cap (role-specific; issue #184 assigned-Skills contract)', () => {
    expect(utf8Bytes(memberPersona(team, 'worker', 'implementer'))).toBeLessThanOrEqual(2_000)
  })
})

describe('tool-schema prompt cost (issue #185)', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/tools/team-lifecycle.ts', import.meta.url)), 'utf8')
  const addMemberDescription = source.match(/name: 'agent_swarm_add_member',[\s\S]*?description: '([^']*)'/)?.[1] ?? ''
  const setProfileDescription = (source.match(/name: 'agent_swarm_set_captain_profile'[\s\S]*?description: (["'])((?:\\.|(?!\1).)*)\1/s)?.[2] ?? '')

  it('removes detailed SVG construction grammar from always-visible tool descriptions', () => {
    for (const description of [addMemberDescription, setProfileDescription]) {
      expect(description.length).toBeGreaterThan(0)
      expect(utf8Bytes(description)).toBeLessThanOrEqual(700)
      for (const grammar of ['<svg', 'viewBox', '<rect', '#RRGGBB', 'self-closing']) {
        expect(description).not.toContain(grammar)
      }
    }
    // The optional avatar contract stays visible in one compact line.
    expect(addMemberDescription).toMatch(/optional/i)
    expect(setProfileDescription).toMatch(/optional/i)
  })
})
