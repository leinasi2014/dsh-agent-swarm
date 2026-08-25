import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from 'vitest'
import { FailingStreamAdapter, mountFreshV2Composition } from './helpers/fresh-v2-composition.js'

function holdWitnessSentinel(ctx: Context): {
  readonly entered: Promise<void>
  readonly release: () => void
  readonly count: () => number
  readonly dispose: () => unknown
} {
  let signalEntered!: () => void
  let releaseSentinel!: () => void
  const entered = new Promise<void>(resolveEntered => { signalEntered = resolveEntered })
  const release = new Promise<void>(resolveRelease => { releaseSentinel = resolveRelease })
  let count = 0
  const dispose = ctx.on('llm/stream', (options, next) => {
    if (options.model !== 'dsh-agent-swarm-witness-sentinel') return next()
    return (async function* (): AsyncIterable<StreamChunk> {
      count += 1
      signalEntered()
      await release
      yield* next()
    })()
  }, { global: true, prepend: true })
  return { entered, release: releaseSentinel, count: () => count, dispose }
}

describe('A1b fixed-Profile witness capability', () => {
  const roots: string[] = []

  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  it('revokes after provider topology mutation and never republishes', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-swarm-a1b-topology-'))
    roots.push(sandbox)
    const mounted = await mountFreshV2Composition(sandbox, () => new FailingStreamAdapter())
    try {
      expect(await mounted.ctx.agentSwarmV2Initial.assertWitnessCapabilityCurrent()).toMatch(/^[0-9a-f]{64}$/)
      const disposeRoute = mounted.ctx.llm.registerAdapter(['changed-route'], new FailingStreamAdapter())
      await expect(mounted.ctx.agentSwarmV2Initial.assertWitnessCapabilityCurrent())
        .rejects.toMatchObject({ code: 'TEAM_RUNTIME_NOT_STARTED' })
      disposeRoute()
      await expect(mounted.ctx.agentSwarmV2Initial.assertWitnessCapabilityCurrent())
        .rejects.toMatchObject({ code: 'TEAM_RUNTIME_NOT_STARTED' })
    } finally {
      for (const fiber of mounted.fibers.toReversed()) await fiber.dispose().catch(() => undefined)
    }
  })

  it('rejects a newly prepended short-circuit route before Team admission', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-swarm-a1b-listener-'))
    roots.push(sandbox)
    const mounted = await mountFreshV2Composition(sandbox, () => new FailingStreamAdapter())
    const disposeListener = mounted.ctx.on('llm/stream', (_options, _next) => (async function* () {
      yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
    })(), { global: true, prepend: true })
    try {
      await expect(mounted.ctx.agentSwarmV2Initial.assertWitnessCapabilityCurrent())
        .rejects.toMatchObject({ code: 'TEAM_RUNTIME_NOT_STARTED' })
    } finally {
      await disposeListener()
      for (const fiber of mounted.fibers.toReversed()) await fiber.dispose().catch(() => undefined)
    }
  })

  it('cannot publish stale capability when topology changes during activation', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-swarm-a1b-activation-race-'))
    roots.push(sandbox)
    const mounted = await mountFreshV2Composition(sandbox, () => new FailingStreamAdapter())
    const held = holdWitnessSentinel(mounted.ctx)
    try {
      const activation = mounted.ctx.agentSwarmV2Initial.assertWitnessCapabilityCurrent()
      await held.entered
      const disposeRoute = mounted.ctx.llm.registerAdapter(['activation-race-route'], new FailingStreamAdapter())
      held.release()
      await expect(activation).rejects.toMatchObject({ code: 'TEAM_RUNTIME_NOT_STARTED' })
      disposeRoute()
      await expect(mounted.ctx.agentSwarmV2Initial.assertWitnessCapabilityCurrent())
        .rejects.toMatchObject({ code: 'TEAM_RUNTIME_NOT_STARTED' })
    } finally {
      held.release()
      await held.dispose()
      for (const fiber of mounted.fibers.toReversed()) await fiber.dispose().catch(() => undefined)
    }
  })

  it('singleflights concurrent first capability assertions', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-swarm-a1b-singleflight-'))
    roots.push(sandbox)
    const mounted = await mountFreshV2Composition(sandbox, () => new FailingStreamAdapter())
    const held = holdWitnessSentinel(mounted.ctx)
    try {
      const first = mounted.ctx.agentSwarmV2Initial.assertWitnessCapabilityCurrent()
      await held.entered
      const second = mounted.ctx.agentSwarmV2Initial.assertWitnessCapabilityCurrent()
      await Promise.resolve()
      expect(held.count()).toBe(1)
      held.release()
      expect(await second).toBe(await first)
    } finally {
      held.release()
      await held.dispose()
      for (const fiber of mounted.fibers.toReversed()) await fiber.dispose().catch(() => undefined)
    }
  })

  it('cannot publish capability after disposal starts during activation', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-swarm-a1b-disposal-race-'))
    roots.push(sandbox)
    const mounted = await mountFreshV2Composition(sandbox, () => new FailingStreamAdapter())
    const held = holdWitnessSentinel(mounted.ctx)
    try {
      const activation = mounted.ctx.agentSwarmV2Initial.assertWitnessCapabilityCurrent()
      await held.entered
      await mounted.ctx.agentSwarmV2Initial.dispose()
      held.release()
      await expect(activation).rejects.toMatchObject({ code: 'TEAM_RUNTIME_NOT_STARTED' })
      await expect(mounted.ctx.agentSwarmV2Initial.assertWitnessCapabilityCurrent())
        .rejects.toMatchObject({ code: 'TEAM_RUNTIME_NOT_STARTED' })
    } finally {
      held.release()
      await held.dispose()
      for (const fiber of mounted.fibers.toReversed()) await fiber.dispose().catch(() => undefined)
    }
  })
})
