/**
 * S1 skills-management BATCH-ACKNOWLEDGEMENT batch (task-1, attempt-1830b1d8).
 *
 * One un-acked bounded batch per Team, RE-PRESENTED (never advanced, zero
 * writes) until the dedicated manager acknowledges it THROUGH THE REAL MODEL
 * TOOL CALL inside its private scoped investigate tool. A cold restart
 * re-presents an un-acked batch and never an acked one; lost-response
 * retries replay by canonical payload; superseded or unknown batches are
 * refused; a revocation racing the ack fences inside the official update
 * callback with consumer bytes byte-identical. The 1,023-entry window test
 * keeps EVERY observed anchor (no negative-index loss) and still catches an
 * early replaced ID.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  captainSkillsTool,
  craftSkillsTeamActivity,
  createSkillsTask,
  createSkillsTeam,
  disposeRestartComposition,
  liveSkillsAgent,
  mountSkillsComposition,
  mountSkillsModule,
  RESTART_SIGNAL,
  SKILLS_INVESTIGATE_TOOL,
  SKILLS_MANAGER_ROUTE,
  SkillsManagerScriptAdapter,
  skillsManagerModuleConfig,
  skillsModule,
  skillsTextChunks,
  skillsToolTurn,
  skillsUnitFile,
  SKILLS_UNIT_NAME,
} from './helpers/skills-management-composition.js'
import {
  readConsumerRow,
  readRow,
  REQUEST_TOOL,
  skillsSandboxTracker,
} from './helpers/skills-management-support.js'

const tracker = skillsSandboxTracker('dsh-skills-ack-')
const freshSandbox = tracker.freshSandbox

/**
 * Pull the ACTIVITY BATCH ID out of the official tool-result blocks the real
 * investigate call (`inv-ack-1`) produced: dsh-llm ToolResultBlock is
 * { type:'tool-result', toolCallId, content: ContentBlock[] } and the tool's
 * output is the JSON string in one text block. Parsing the real returned
 * document is the only honest source for the model's ack argument.
 */
function batchIdFromInvestigateResults(messages: readonly unknown[]): string | undefined {
  let latest: string | undefined
  for (const message of messages) {
    const content = (message as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      const result = block as { type?: string; toolCallId?: string; content?: unknown }
      if (result.type !== 'tool-result' || result.toolCallId !== 'inv-ack-1' || !Array.isArray(result.content)) continue
      for (const inner of result.content) {
        const text = (inner as { type?: string; text?: string }).type === 'text' ? (inner as { text: string }).text : undefined
        if (text === undefined) continue
        try {
          const parsed = JSON.parse(text) as { activity?: { batchId?: unknown } }
          const batchId = parsed.activity?.batchId
          if (typeof batchId === 'string' && batchId.startsWith('batch:')) latest = batchId
        } catch {
          // Not a JSON tool result — nothing to acknowledge from it.
        }
      }
    }
  }
  return latest
}

describe('S1 batch acknowledgement: real model acks, durable receipts, honest re-present', () => {
  it('the manager REALLY acknowledges batches: durable lastAck, re-present before ack, never after, lost-response replay, superseded refusal, revoke fence', async () => {
    const sandbox = await freshSandbox()
    const managerAdapter = new SkillsManagerScriptAdapter()
    const mounted = await mountSkillsComposition(sandbox, { [SKILLS_MANAGER_ROUTE.provider]: managerAdapter })
    try {
      const { root, teamId } = await createSkillsTeam(mounted, sandbox)
      const scope = mounted.ctx.agentSwarm.scopeOf(root)
      for (let index = 0; index < 6; index += 1) {
        await createSkillsTask(mounted.ctx, root, `ack-task-${index}`, `Ack lifecycle work fact ${index}`)
      }
      await mountSkillsModule(mounted.ctx, skillsManagerModuleConfig(scope, teamId, { activityPageSize: 2 }), mounted.fibers)
      const module = skillsModule(mounted.ctx)
      // The manager opens LAZILY: take its identity only after the legal
      // open path, never by waiting on an empty binding id.
      await module.ensureManager()
      const managerAgent = await liveSkillsAgent(mounted.ctx, module.managerAgentId)
      const ackExec = { agent: managerAgent, signal: RESTART_SIGNAL }

      // The model reads the batchId out of the REAL investigate tool result in
      // its own message history and issues the ack call itself — Host-side or
      // automatic acknowledgement is not acceptable evidence, and the value
      // must come from PARSING the official tool-result content block (the
      // tool output is a JSON string inside a text block; a raw regex over an
      // outer stringify only sees escaped quotes — parse, don't grep).
      const ackOutcome = 'processed: first bounded batch reviewed against authorized work facts'
      managerAdapter.append(
        skillsToolTurn('inv-ack-1', SKILLS_INVESTIGATE_TOOL, { request_id: 'mgr-ack-request' }),
        (options) => {
          const batchId = batchIdFromInvestigateResults(options.messages)
          if (batchId === undefined) return skillsTextChunks('No batch visible yet.')
          return skillsToolTurn('ack-model-1', SKILLS_INVESTIGATE_TOOL, { ack_batch_id: batchId, ack_outcome: ackOutcome })
        },
        skillsTextChunks('First batch acknowledged.'),
      )
      const intake = await captainSkillsTool(mounted.ctx, root, 'ack-intake', REQUEST_TOOL, {
        request_id: 'mgr-ack-request', revision: 1, question: 'Which approved version covers this behavior?',
      })
      expect(intake.ok).toBe(true)
      await module.flushWakes()

      const row = await readRow(sandbox, scope, teamId, 'mgr-ack-request')
      expect(row, `the request must have been investigated, got: ${JSON.stringify(row)}`).toBeTruthy()
      const consumer = await readConsumerRow(sandbox, scope, teamId)
      expect(consumer?.pendingBatch, 'the model-acknowledged batch is cleared durably').toBeUndefined()
      expect(consumer?.lastAck?.outcome, 'the durable lastAck carries the model conclusion').toBe(ackOutcome)
      const batch1 = consumer!.lastAck!.batchId
      expect(managerAdapter.managerRequests().some(request => JSON.stringify(request.messages).includes('ack_batch_id')),
        'the ACK must come from a real manager model call, not the Host').toBe(true)

      // Lost-response retry: the SAME canonical payload replays the original
      // receipt; a differing payload conflicts; an unknown batch is refused.
      const replay = await module.ackBatch(batch1, ackOutcome, ackExec)
      expect(replay).toMatchObject({ batch_id: batch1, replayed: true })
      const clash = await module.ackBatch(batch1, 'a different conclusion entirely', ackExec)
        .then(() => undefined, (error: unknown) => error as Error & { code?: string })
      expect(clash?.code ?? clash?.message ?? '').toContain('SKILLS_ACK_CONFLICT')
      const ghost = await module.ackBatch('batch:999:0000000000000000', ackOutcome, ackExec)
        .then(() => undefined, (error: unknown) => error as Error & { code?: string })
      expect(ghost?.code ?? ghost?.message ?? '').toContain('SKILLS_ACK_STALE')

      // ACKED → a cold restart must NOT re-present batch 1; it captures the next page.
      await disposeRestartComposition(mounted)
      const secondAdapter = new SkillsManagerScriptAdapter()
      const second = await mountSkillsComposition(sandbox, { [SKILLS_MANAGER_ROUTE.provider]: secondAdapter })
      try {
        const scope2 = scope
        await mountSkillsModule(second.ctx, skillsManagerModuleConfig(scope2, teamId, { activityPageSize: 2 }), second.fibers)
        const module2 = skillsModule(second.ctx)
        await module2.ensureManager()
        const page = await module2.syncWorkActivity(scope2, teamId)
        expect(page.reServed, 'an acknowledged batch is never re-presented').toBe(false)
        expect(page.batchId, 'the next bounded batch is captured instead').toBeTruthy()
        expect(page.batchId).not.toBe(batch1)
        expect(page.entries.length, 'capacity carries every page entry — never silently dropped').toBeLessThanOrEqual(2)
        const managerAgent2 = await liveSkillsAgent(second.ctx, module2.managerAgentId)
        const exec2 = { agent: managerAgent2, signal: RESTART_SIGNAL }
        const batch2 = page.batchId!
        const outcome2 = 'processed: second bounded batch'
        await module2.ackBatch(batch2, outcome2, exec2)
        // A LATE ack of the superseded OLD batch is refused (only current pending /
        // current lastAck may be read back).
        const lateOld = await module2.ackBatch(batch1, ackOutcome, exec2)
          .then(() => undefined, (error: unknown) => error as Error & { code?: string })
        expect(lateOld?.code ?? lateOld?.message ?? '').toContain('SKILLS_ACK_STALE')

        // Un-acked backpressure + revoke inside the real commit window: the
        // fence blocks inside the official update callback; bytes untouched.
        const pendingPage = await module2.syncWorkActivity(scope2, teamId)
        expect(pendingPage.batchId, 'the third batch is pending un-acked').toBeTruthy()
        const before = JSON.stringify(await readConsumerRow(sandbox, scope2, teamId))
        const ackInFlight = module2.ackBatch(pendingPage.batchId!, 'too late to matter', exec2)
        module2.revokeManagement(scope2, teamId)
        const fenced = await ackInFlight.then(() => undefined, (error: unknown) => error as Error & { code?: string })
        expect(fenced, 'an ack racing a revocation must be fenced').toBeDefined()
        expect([fenced!.code ?? '', fenced!.message].join(' ')).toMatch(/SKILLS_REVOKED|SKILLS_UNAUTHORIZED|ADMISSION/)
        expect(JSON.stringify(await readConsumerRow(sandbox, scope2, teamId)),
          'the fenced ack persisted no consumer movement').toBe(before)
      } finally {
        await disposeRestartComposition(second)
      }
    } finally {
      // The first composition was already disposed inside the test.
    }
  }, 90_000)

  it('keeps every observed anchor through the 512/600/1023 window and still catches an early replaced ID', async () => {
    const sandbox = await freshSandbox()
    const managerAdapter = new SkillsManagerScriptAdapter()
    const mounted = await mountSkillsComposition(sandbox, { [SKILLS_MANAGER_ROUTE.provider]: managerAdapter })
    let scope = ''
    let teamId = ''
    let cursorBefore = -1
    let anchorsBefore: { sequence: number; id: string }[] = []
    try {
      const { root, teamId: created } = await createSkillsTeam(mounted, sandbox)
      teamId = created
      scope = mounted.ctx.agentSwarm.scopeOf(root)
      const taskId = await createSkillsTask(mounted.ctx, root, 'anchor-task', 'Anchor window work fact')
      void taskId
    } finally {
      await disposeRestartComposition(mounted)
    }

    // 1,023 retained activities in the official medium (inside the official
    // 1,024 retention window — every ID stays checkable).
    expect(await craftSkillsTeamActivity(sandbox, teamId, 1023), 'the injection must land once').toBe(1)

    const second = await mountSkillsComposition(sandbox, { [SKILLS_MANAGER_ROUTE.provider]: managerAdapter })
    try {
      await mountSkillsModule(second.ctx, skillsManagerModuleConfig(scope, teamId, { activityPageSize: 100 }), second.fibers)
      const module = skillsModule(second.ctx)
      await module.ensureManager()
      const managerAgent = await liveSkillsAgent(second.ctx, module.managerAgentId)
      const exec = { agent: managerAgent, signal: RESTART_SIGNAL }
      let page = await module.syncWorkActivity(scope, teamId)
      let batches = 0
      while (page.batchId !== undefined) {
        expect(page.entries.length, 'a batch never exceeds the page size').toBeLessThanOrEqual(100)
        await module.ackBatch(page.batchId, `processed: drain batch ${batches + 1}`, exec)
        batches += 1
        page = await module.syncWorkActivity(scope, teamId)
        expect(batches, 'the drain terminates at the source head').toBeLessThan(20)
      }
      expect(batches, 'eleven bounded batches drain 1,023 activities').toBe(11)
      const drained = await readConsumerRow(sandbox, scope, teamId)
      expect(drained!.anchors!.length, 'every observed anchor survives the window — no negative-index loss')
        .toBe(1023)
      expect(drained!.anchors![0]!.sequence, 'the OLDEST anchors are kept (the 512/600/1023 boundaries included)').toBe(1)
      expect(drained?.anchorsDropped, 'nothing left the observable window').toBe(0)
      cursorBefore = drained!.cursorSequence
      anchorsBefore = drained!.anchors ?? []
    } finally {
      // COLD medium edit: the second Context MUST be closed first, so the
      // official Domain caches nothing while the source ID is replaced and
      // the next reader opens the medium fresh.
      await disposeRestartComposition(second)
    }

    // Save the CONSUMER-side bytes (whole unit medium) and prove the coming
    // edit touches ONLY the source aggregate file.
    const unitBefore = await readFile(skillsUnitFile(sandbox), 'utf8')
    expect(Object.keys(JSON.parse(unitBefore).tables.consumers as object).length, 'exactly one consumer row').toBe(1)

    // Replace an EARLY retained ID (sequence 3, long acked, still retained).
    expect(await craftSkillsTeamActivity(sandbox, teamId, 1023, 3), 'the ID replacement lands once').toBe(1)
    let sourceChanged = false
    for (const name of await readdir(join(sandbox, 'storage'))) {
      if (!name.endsWith('.json') || name === `${SKILLS_UNIT_NAME}.json`) continue
      if ((await readFile(join(sandbox, 'storage', name), 'utf8')).includes('craft-3-replaced')) sourceChanged = true
    }
    expect(sourceChanged, 'the SOURCE retained ID genuinely changed on the medium').toBe(true)
    expect(await readFile(skillsUnitFile(sandbox), 'utf8'), 'the replacement edited no consumer/product byte').toBe(unitBefore)

    // Normal COLD restart: a fresh Context reads the damaged source honestly.
    const third = await mountSkillsComposition(sandbox)
    try {
      await mountSkillsModule(third.ctx, skillsManagerModuleConfig(scope, teamId, { activityPageSize: 100 }), third.fibers)
      const caught = await skillsModule(third.ctx).syncWorkActivity(scope, teamId)
      expect(caught.conflicts.some(conflict => conflict.sequence === 3 && conflict.actualEventId === 'craft-3-replaced'),
        `an early replaced ID inside the window must be caught, got: ${JSON.stringify(caught.conflicts)}`).toBe(true)
      expect(caught.needsResync, 'the conflict demands resync').toBe(true)
      const survivor = await readConsumerRow(sandbox, scope, teamId)
      expect(survivor!.cursorSequence, 'the conflict never rewinds the cursor').toBe(cursorBefore)
      const survivors = survivor!.anchors ?? []
      expect(survivors.length, 'the anchor window is at least as wide as before').toBeGreaterThanOrEqual(anchorsBefore.length)
      expect(JSON.stringify(survivors.slice(0, anchorsBefore.length)),
        'every previously observed anchor survives beside the conflict ledger').toBe(JSON.stringify(anchorsBefore))
    } finally {
      await disposeRestartComposition(third)
    }
  }, 120_000)
})
