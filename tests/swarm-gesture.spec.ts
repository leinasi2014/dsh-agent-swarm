/**
 * `/swarm` deterministic gesture activation (SW gap: teams has a slash
 * command; rc.2 has no dsh-commands, so the official `agent/pre-step` seam is
 * the only real entry boundary available).
 *
 * RED scope: the boundary module is authored, but the plugin must WIRE it in
 * `apply()` for the real-composition test to become green. Until then the
 * model request still happens, but carries no activation directive.
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildSwarmActivationDirective, parseSwarmInvocation } from '../src/runtime/gesture.js'
import { mount } from './helpers/gated-composition.js'

describe('/swarm deterministic gesture activation', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
  })

  it('parses only a leading gesture and keeps mid-sentence mention as prose', () => {
    expect(parseSwarmInvocation('/swarm 分析最近交付')).toEqual({ goal: '分析最近交付' })
    expect(parseSwarmInvocation('/swarm')).toEqual({ goal: '' })
    expect(parseSwarmInvocation('  /swarm   x')).toEqual({ goal: 'x' })
    expect(parseSwarmInvocation('/swarmfoo build')).toBeUndefined()
    expect(parseSwarmInvocation('please use swarm to review')).toBeUndefined()
  })

  it('builds a directive naming create_managed and the verbatim goal', () => {
    const text = buildSwarmActivationDirective({ goal: '分析最近交付' })
    expect(text).toContain('agent_swarm_create_managed')
    expect(text).toContain('Goal: 分析最近交付')
    expect(text).toContain('end this turn')
  })

  it('claims the activation directive into the first real model request', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-swarm-gesture-'))
    roots.push(sandbox)
    const composition = await mount(sandbox, 60_000)
    try {
      composition.lead.followup(createUserMessage({
        content: [{ type: 'text', text: '/swarm 分析最近交付' }],
        source: { kind: 'user' },
      }))
      await vi.waitFor(() => {
        expect(composition.adapter.requests.length).toBeGreaterThan(0)
      }, { timeout: 15_000 })
      const request = composition.adapter.requests[0]!
      const text = request.messages.map(message => JSON.stringify(message.content)).join('\n')
      expect(text).toContain('/swarm 分析最近交付')
      expect(text).toContain('agent_swarm_create_managed')
    } finally {
      await composition.pluginFiber.dispose()
      for (const fiber of composition.fibers.toReversed()) await fiber.dispose()
    }
  })
})
