/** A real Domain decision during the final lineage read must fence obsolete notice input. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as lineage from '../src/runtime/public-lineage.js'
import { deliverWorkRequestNotice } from '../src/runtime/work-request-delivery.js'
import { framePredicate } from '../src/runtime/frame-visibility.js'
import { messageFrame } from '../src/runtime/prompts.js'
import { Recording, createTeam, setup } from './helpers/public-chat-real-composition.js'
import { RESTART_SIGNAL as SIGNAL } from './helpers/restart-real-composition.js'

it.each([false, true])('rechecks the notice after the second lineage read (resolved=%s)', async resolved => {
  const sandbox = await mkdtemp(join(tmpdir(), 'swarm-work-delivery-race-'))
  const adapter = new Recording(), f = await setup(sandbox, adapter)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let delivery: Promise<unknown> | undefined
  let spy: { mockRestore(): void } | undefined
  try {
    const { root, captain, teamId, scope } = await createTeam(f, sandbox)
    await f.ctx.subagents.withContinuableChild(root, captain.id, SIGNAL, async currentCaptain => {
      const domain = f.ctx.agentSwarm.domain
      const submitted = await domain.submitWorkRequest(scope, teamId, { kind: 'local-operator' },
        { requestId: 'lineage-race-request', description: 'A request resolved independently while lineage is inspected.' })
      const read = async () => (await domain.snapshot(scope, teamId, currentCaptain.id)).team
      const notice = (await read()).messages.find(row => row.id === submitted.notificationMessageId)!
      const frame = messageFrame(notice)
      const actualEligibility = lineage.publicAppendEligibility
      let calls = 0, entered = false
      spy = vi.spyOn(lineage, 'publicAppendEligibility').mockImplementation(async (...args) => {
        // Both observations perform the real official Session/child-lineage checks.
        const result = await actualEligibility(...args)
        if (++calls === 2) { entered = true; await gate }
        return result
      })
      const running = deliverWorkRequestNotice(f.ctx, {
        domain: () => domain, closing: () => false,
        team: read, root: async () => root, account: async () => {},
      }, scope, teamId, notice.id, SIGNAL)
      delivery = running
      await vi.waitFor(() => expect(entered).toBe(true), { timeout: 10_000 })
      if (resolved) {
        // Use the actual authoritative transaction and exact official Captain identity.
        const rejected = await domain.resolveWorkRequest(scope, teamId, currentCaptain.id, {
          workRequestId: submitted.request.id, expectedRequestRevision: submitted.request.revision,
          decision: { kind: 'reject', publicReason: 'The original request is no longer needed.' },
        })
        expect(rejected.request.resolution).toMatchObject({ kind: 'reject', actorSessionId: currentCaptain.id })
      }
      release()
      const outcome = await running
      await currentCaptain.whenIdle()
      const after = await read()
      expect(after.tasks).toHaveLength(0)
      expect(after.messages.find(row => row.id === notice.id)?.phase).toBe(resolved ? 'obsolete' : 'delivered')
      expect(outcome).toMatchObject({ result: { admitted: !resolved } })
      const noticeRequests = adapter.requests.filter(request => request.sessionId === currentCaptain.id
        && request.messages.some(message => message.role === 'user' && framePredicate(frame)(message as never)))
      expect(noticeRequests).toHaveLength(resolved ? 0 : 1)

      // The obsolete-notice gate must not suppress unrelated ordinary Captain input.
      const ordinary = 'Continue the existing ordinary conversation.'
      currentCaptain.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: ordinary }] }))
      await currentCaptain.whenIdle()
      expect(adapter.requests.some(request => request.sessionId === currentCaptain.id
        && request.messages.some(message => message.role === 'user' && framePredicate(ordinary)(message as never)))).toBe(true)
    })
  } finally {
    release()
    await delivery?.catch(() => {})
    spy?.mockRestore()
    await f.close()
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 30_000)
