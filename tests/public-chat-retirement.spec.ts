/** Retirement and cancellation against actual official cold continuation admission. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { publicDeliveries } from '../src/domain/public-message.js'
import { readPersistedSession } from '../src/runtime/persisted-session.js'
import { framePredicate } from '../src/runtime/frame-visibility.js'
import { MessageDelivery } from '../src/runtime/message-delivery.js'
import { RESTART_SIGNAL as SIGNAL } from './helpers/restart-real-composition.js'
import { Recording, setup, createTeam, addPublicMembers } from './helpers/public-chat-real-composition.js'

it.each([
  ['remove', false], ['archive', false], ['remove', true], ['archive', true],
] as const)('fences %s completion against an in-flight public cold member observation (cancelled=%s)', async (operation, cancelled) => {
  const sandbox = await mkdtemp(join(tmpdir(), `swarm-public-exit-${operation}-`))
  const adapter = new Recording()
  const f = await setup(sandbox, adapter)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  try {
    const { root, captain, teamId, scope } = await createTeam(f, sandbox)
    const [memberId] = await addPublicMembers(f, root, captain.id)
    await f.ctx.subagents.withContinuableChild(root, captain.id, SIGNAL, async (liveCaptain) => {
      await f.ctx.subagents.drainContinuableChildren(liveCaptain, [memberId!])
      expect(f.ctx.agents.get(memberId!)).toBeUndefined()
      const committed = await f.ctx.agentSwarm.domain.appendPublicMessage(scope, teamId, {
        formatVersion: 2, author: { kind: 'local-operator' }, requestId: `cold-exit-${operation}`,
        content: [{ type: 'mention', memberId: memberId! }, { type: 'text', text: 'Finish this public request.' }],
      })
      const frame = publicDeliveries(committed.message)[0]!.frame
      let observed!: () => void
      const entered = new Promise<void>(resolve => { observed = resolve })
      let insideTargetPrompt = false
      const actualPrompt = f.ctx.subagents.prompt.bind(f.ctx.subagents)
      const prompt = vi.spyOn(f.ctx.subagents, 'prompt').mockImplementation(async (request, signal) => {
        if (request.childSessionId !== memberId) return await actualPrompt(request, signal)
        insideTargetPrompt = true
        try { return await actualPrompt(request, signal) } finally { insideTargetPrompt = false }
      })
      const actualObserve = f.ctx.sessionQuery.observeSession.bind(f.ctx.sessionQuery)
      const observe = vi.spyOn(f.ctx.sessionQuery, 'observeSession').mockImplementation(async (id, options) => {
        if (id === memberId && insideTargetPrompt) {
          observed()
          await gate
        }
        return await actualObserve(id, options)
      })
      const deliveries = vi.spyOn(MessageDelivery.prototype, 'deliverPublicMessages')
      let exitCompleted = false
      let modelsAtExit = -1
      let inputsAtExit = -1
      const cancellation = new AbortController()
      const memberModels = () => adapter.requests.filter(request => request.sessionId === memberId).length
      try {
        f.ctx.agentSwarm.kickPublicMessages(scope, teamId)
        const draining = deliveries.mock.results.at(-1)!.value as Promise<unknown>
        await entered
        expect(f.ctx.agents.get(memberId!)).toBeUndefined()
        const exiting = (operation === 'remove'
          ? f.ctx.agentSwarm.removeMember({ agent: liveCaptain, signal: cancellation.signal }, 'alpha', 'leave during cold admission')
          : f.ctx.agentSwarm.archive({ agent: liveCaptain, signal: cancellation.signal }, 'archive during cold admission'))
          .then(async value => {
            modelsAtExit = memberModels()
            const stored = await readPersistedSession(f.ctx.sessionPersistence, memberId!, SIGNAL)
            inputsAtExit = stored.events.slice(stored.inheritedEventCount ?? 0)
              .flatMap(event => event.type === 'user/message' ? [event.data] : []).filter(framePredicate(frame)).length
            exitCompleted = true
            return value
          })
        const outcome = exiting.then(() => ({ ok: true as const }), error => ({ ok: false as const, error }))
        // Give the real mutation its normal async commit/drain opportunities.
        // The held official observation must prevent a successful early return.
        await new Promise(resolve => setTimeout(resolve, 150))
        const returnedBeforeObservation = exitCompleted
        const cancelReason = new Error('Cancelled while retirement waits for public admission')
        if (cancelled) cancellation.abort(cancelReason)
        release()
        const result = await outcome
        await draining
        if (cancelled) {
          expect(result).toEqual({ ok: false, error: cancelReason })
          const team = (await f.ctx.agentSwarm.domain.snapshot(scope, teamId, captain.id)).team
          expect(team.phase).toBe('active')
          expect(team.members.find(member => member.sessionId === memberId)?.phase).toBe('active')
          return
        }
        expect(result).toEqual({ ok: true })
        await f.ctx.agents.get(memberId!)?.whenIdle()
        const after = await readPersistedSession(f.ctx.sessionPersistence, memberId!, SIGNAL)
        const ownInputs = after.events.slice(after.inheritedEventCount ?? 0)
          .flatMap(event => event.type === 'user/message' ? [event.data] : []).filter(framePredicate(frame))
        expect(memberModels(), 'no member model invocation may start after exit completes').toBe(modelsAtExit)
        expect(ownInputs.length, 'no public member input may arrive after exit completes').toBe(inputsAtExit)
        expect(returnedBeforeObservation, 'exit must await the official cold observation it fences').toBe(false)
        expect(ownInputs.length).toBeLessThanOrEqual(1)
        expect(f.ctx.agents.get(memberId!)).toBeUndefined()
      } finally { release(); observe.mockRestore(); prompt.mockRestore(); deliveries.mockRestore() }
    })
  } finally { release(); await f.close(); await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 20_000)

