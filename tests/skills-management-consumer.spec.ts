/**
 * S1 skills-management Consumer batch (task-1, attempt-1830b1d8).
 *
 * The dedicated manager's authorized activity read must be an honest,
 * resumable consumer over the ONE official Team aggregate: the first touch
 * takes the task/attempt watermarks AND the activity watermark from the SAME
 * snapshot; each page advances the cursor only to the page tail with the
 * pending refs in ONE consumer-record write; and retention gaps, source
 * regression, same-sequence-different-ID, archived, and missing sources are
 * each explicitly visible — never a fake "caught up" empty page.
 *
 * Source-damage cases reopen the SAME durable roots in a fresh Context and
 * inject the damage into the official medium (the only way these conditions
 * physically happen), with a touched-count assertion proving each injection
 * actually landed on the one Team aggregate. The replaced-ID case replaces a
 * REAL retained source ID only, leaving consumer bytes untouched — the
 * consumer's cursor, pending batch, and anchors must survive while the
 * conflict surfaces durably and stickily (root ruling ②).
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { skillsConsumerKey } from '../src/storage/skills-management.js'
import type { SkillsSyncPage } from '../src/skills/module.js'
import {
  createSkillsTask,
  createSkillsTeam,
  disposeRestartComposition,
  mountSkillsComposition,
  mountSkillsModule,
  SKILLS_UNIT_NAME,
  skillsModule,
  skillsUnitFile,
} from './helpers/skills-management-composition.js'
import { installSkillsSourceReadBarrier } from './helpers/skills-management-support.js'

const SANDBOXES: string[] = []
afterAll(async () => {
  for (const dir of SANDBOXES) await rm(dir, { recursive: true, force: true })
})

async function freshSandbox(): Promise<string> {
  const sandbox = await mkdtemp(join(tmpdir(), 'dsh-skills-cons-'))
  SANDBOXES.push(sandbox)
  return sandbox
}

type Mutable = Record<string, unknown>

interface ConsumerRow extends Mutable {
  cursorSequence: number
  sourceState: string
  needsResync: boolean
  pendingBatch?: { batchId: string; refs: { sequence: number; id: string; kind: string }[] }
  lastAck?: { batchId: string; outcome: string; refs: { sequence: number; id: string }[] }
  anchors: { sequence: number; id: string }[]
  anchorsDropped: number
  gaps: { fromSequence: number; toSequence: number }[]
  conflicts: { sequence: number; expectedEventId: string; actualEventId: string }[]
  sourceRegression?: { cursorSequence: number; observedThroughSequence: number }
  baseline?: { capturedTeamRevision: number; throughSequence: number; legacyNoWorkActivity: boolean; taskWatermarks: { taskId: string }[]; retainedFromSequence?: number }
}

async function readConsumer(sandbox: string, scope: string, teamId: string): Promise<ConsumerRow | undefined> {
  const unit = JSON.parse(await readFile(skillsUnitFile(sandbox), 'utf8')) as { tables: { consumers: Record<string, ConsumerRow | undefined> } }
  return unit.tables.consumers[skillsConsumerKey(scope, teamId)]
}

/**
 * Inject damage into the official Team aggregate medium between mounts.
 * The official store persists the aggregate inside a `TeamRecord` envelope
 * `{ workspace, team: TeamState }` (src/storage/team-spec.ts `teamRecordOf`);
 * the mutation targets the REAL record shape and the touched count proves
 * the injection landed on exactly the one Team aggregate — an injection that
 * silently matched nothing can never masquerade as a fault-injected test.
 */
async function craftTeam(sandbox: string, teamId: string, mutate: (team: Mutable) => void): Promise<number> {
  const dir = join(sandbox, 'storage')
  let touched = 0
  for (const name of await readdir(dir)) {
    if (!name.endsWith('.json') || name === `${SKILLS_UNIT_NAME}.json`) continue
    const file = join(dir, name)
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { tables?: Record<string, Record<string, Mutable | undefined> | undefined> }
    if (parsed.tables === undefined) continue
    let fileTouched = 0
    for (const rows of Object.values(parsed.tables)) {
      for (const row of Object.values(rows ?? {})) {
        if (row === null || typeof row !== 'object') continue
        const wrapped = row.team as Mutable | null | undefined
        const team = wrapped !== undefined && wrapped !== null && typeof wrapped === 'object' && Array.isArray(wrapped.tasks)
          ? wrapped
          : Array.isArray(row.tasks) ? row : undefined
        if (team !== undefined && team.id === teamId) {
          mutate(team)
          fileTouched += 1
        }
      }
    }
    if (fileTouched > 0) {
      touched += fileTouched
      await writeFile(file, JSON.stringify(parsed))
    }
  }
  return touched
}

async function craftTeamOnce(sandbox: string, teamId: string, mutate: (team: Mutable) => void): Promise<void> {
  expect(await craftTeam(sandbox, teamId, mutate), 'the fault injection must land on exactly the one Team aggregate').toBe(1)
}

/** Mutate the OUTER TeamRecord envelope layer (where `workspace` lives). */
async function craftEnvelope(sandbox: string, teamId: string, mutate: (row: Mutable) => void): Promise<number> {
  const dir = join(sandbox, 'storage')
  let touched = 0
  for (const name of await readdir(dir)) {
    if (!name.endsWith('.json') || name === `${SKILLS_UNIT_NAME}.json`) continue
    const file = join(dir, name)
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { tables?: Record<string, Record<string, Mutable | undefined> | undefined> }
    if (parsed.tables === undefined) continue
    let fileTouched = 0
    for (const rows of Object.values(parsed.tables)) {
      for (const row of Object.values(rows ?? {})) {
        if ((row?.team as Mutable | undefined)?.id === teamId) {
          mutate(row!)
          fileTouched += 1
        }
      }
    }
    if (fileTouched > 0) {
      touched += fileTouched
      await writeFile(file, JSON.stringify(parsed))
    }
  }
  return touched
}

function workActivityOf(team: Mutable): { entries: { sequence: number; id: string }[]; nextSequence: number } | undefined {
  return team.workActivity as { entries: { sequence: number; id: string }[]; nextSequence: number } | undefined
}

describe('S1 consumer: one honest writer over the official Team aggregate', () => {
  it('marks a legacy Team (no workActivity) explicitly without faking advancement', async () => {
    const sandbox = await freshSandbox()
    const mounted = await mountSkillsComposition(sandbox)
    try {
      const { root, teamId } = await createSkillsTeam(mounted, sandbox)
      const scope = mounted.ctx.agentSwarm.scopeOf(root)
      await mountSkillsModule(mounted.ctx, { management: [{ scope, teamId }] }, mounted.fibers)
      const page = await skillsModule(mounted.ctx).syncWorkActivity(scope, teamId)
      expect(page).toMatchObject({ sourceState: 'available', legacyNoWorkActivity: true, cursorSequence: 0, hasMore: false, needsResync: false })
      expect(page.entries).toHaveLength(0)
      const row = await readConsumer(sandbox, scope, teamId)
      expect(row?.baseline?.legacyNoWorkActivity, 'the legacy watermark must be durable').toBe(true)
    } finally {
      await disposeRestartComposition(mounted)
    }
  }, 40_000)

  it('captures ONE bounded batch per Team from a single-aggregate baseline and re-serves it un-acked with zero writes', async () => {
    const sandbox = await freshSandbox()
    const mounted = await mountSkillsComposition(sandbox)
    let scope = ''
    let teamId = ''
    let batchId = ''
    let cursor = 0
    try {
      const { root, teamId: created } = await createSkillsTeam(mounted, sandbox)
      teamId = created
      scope = mounted.ctx.agentSwarm.scopeOf(root)
      const taskIds: string[] = []
      for (let index = 0; index < 4; index += 1) {
        taskIds.push(await createSkillsTask(mounted.ctx, root, `cons-task-${index}`, `Pagination work fact ${index}`))
      }
      await mountSkillsModule(mounted.ctx, { management: [{ scope, teamId }], activityPageSize: 2 }, mounted.fibers)
      const module = skillsModule(mounted.ctx)

      const first = await module.syncWorkActivity(scope, teamId)
      expect(first.legacyNoWorkActivity, 'this Team has real workActivity').toBe(false)
      expect(first.entries.length, 'a batch never exceeds the configured page size').toBeLessThanOrEqual(2)
      expect(first.batchId, 'the captured batch identity is durable-before-response').toBeTruthy()
      batchId = first.batchId!
      const baselineRow = await readConsumer(sandbox, scope, teamId)
      expect(baselineRow?.baseline, 'the same update persists one baseline').toBeTruthy()
      expect(baselineRow!.baseline!.capturedTeamRevision, 'the baseline revision comes from the SAME aggregate snapshot').toBeGreaterThan(0)
      expect(baselineRow!.baseline!.retainedFromSequence, 'the retention floor is durable').toBeTypeOf('number')
      const watermarked = new Set(baselineRow!.baseline!.taskWatermarks.map(task => task.taskId))
      for (const taskId of taskIds) expect(watermarked.has(taskId), `task watermark for ${taskId}`).toBe(true)
      expect(baselineRow?.pendingBatch?.refs, 'capacity never silently drops refs').toHaveLength(first.entries.length)
      expect(JSON.stringify(baselineRow?.pendingBatch?.refs), 'the durable refs are the batch served').toBe(JSON.stringify(first.entries))
      cursor = first.cursorSequence
      expect(cursor, 'the cursor lands exactly on the page tail').toBe(first.entries.at(-1)?.sequence)

      // Un-acked: the NEXT read RE-SERVES the same batch — no next page, no
      // eviction, and above all ZERO consumer writes.
      let writes = 0
      const stop = mounted.ctx.on('domain/changed', (event: { domain?: string; table?: string }) => {
        if (event.domain === SKILLS_UNIT_NAME && event.table === 'consumers') writes += 1
      })
      let again: SkillsSyncPage
      try {
        again = await module.syncWorkActivity(scope, teamId)
      } finally { stop() }
      expect(again.reServed, 'an un-acked batch is re-served').toBe(true)
      expect(again.batchId, 'the re-served batch identity is the SAME batch, not the next page').toBe(batchId)
      expect(JSON.stringify(again.entries), 'the re-served refs are byte-identical').toBe(JSON.stringify(first.entries))
      expect(writes, 'a re-serve never writes the consumer record').toBe(0)
      expect(again.hasMore, 'more source beyond the un-acked batch stays visible').toBe(true)
    } finally {
      await disposeRestartComposition(mounted)
    }

    // COLD RESTART with the batch still un-acked: the ORIGINAL batch is
    // re-presented (never the next page, never lost).
    const second = await mountSkillsComposition(sandbox)
    try {
      await mountSkillsModule(second.ctx, { management: [{ scope, teamId }], activityPageSize: 2 }, second.fibers)
      const resumed = await skillsModule(second.ctx).syncWorkActivity(scope, teamId)
      expect(resumed.reServed, 'cold restart re-presents the un-acked batch').toBe(true)
      expect(resumed.batchId, 'the batch identity survives the restart').toBe(batchId)
      expect(resumed.cursorSequence, 'the cursor stayed at the batch tail').toBe(cursor)
      const row = await readConsumer(sandbox, scope, teamId)
      expect(row?.needsResync, 'clean batched consumption needs no resync').toBe(false)
      expect(row?.gaps, 'clean consumption records no gaps').toHaveLength(0)
      expect(row?.conflicts, 'clean consumption records no conflicts').toHaveLength(0)
    } finally {
      await disposeRestartComposition(second)
    }
  }, 60_000)

  it('a source regression demands resync: nothing advances and no empty caught-up page is faked', async () => {
    const sandbox = await freshSandbox()
    const mounted = await mountSkillsComposition(sandbox)
    let scope = ''
    let teamId = ''
    let cursor = 0
    try {
      const { root, teamId: created } = await createSkillsTeam(mounted, sandbox)
      teamId = created
      scope = mounted.ctx.agentSwarm.scopeOf(root)
      for (let index = 0; index < 3; index += 1) await createSkillsTask(mounted.ctx, root, `reg-task-${index}`, `Regression work fact ${index}`)
      await mountSkillsModule(mounted.ctx, { management: [{ scope, teamId }] }, mounted.fibers)
      const module = skillsModule(mounted.ctx)
      let page = await module.syncWorkActivity(scope, teamId)
      while (page.hasMore) page = await module.syncWorkActivity(scope, teamId)
      cursor = page.cursorSequence
      expect(cursor).toBeGreaterThan(0)
    } finally {
      await disposeRestartComposition(mounted)
    }

    // The official source physically loses the head (retention regression).
    const pendingBefore = await readConsumer(sandbox, scope, teamId)
    const batchIdBefore = pendingBefore?.pendingBatch?.batchId
    const refsBefore = JSON.stringify(pendingBefore?.pendingBatch?.refs)
    expect(batchIdBefore, 'the drained-but-un-acked batch is still pending').toBeTruthy()
    await craftTeamOnce(sandbox, teamId, team => {
      const activity = workActivityOf(team)
      expect(activity, 'the aggregate must carry retained workActivity').toBeTruthy()
      activity!.nextSequence = cursor - 1
      activity!.entries = activity!.entries.filter(entry => entry.sequence < cursor - 1)
    })

    const second = await mountSkillsComposition(sandbox)
    try {
      await mountSkillsModule(second.ctx, { management: [{ scope, teamId }] }, second.fibers)
      const page = await skillsModule(second.ctx).syncWorkActivity(scope, teamId)
      expect(page.hasMore, 'a regressed source must NEVER present as caught up').toBe(false)
      // Per the one-batch contract the UN-ACKED batch is honestly re-served
      // (same refs, never a fake fresh page); regression is recorded sticky.
      expect(page.reServed, 'the pending batch is re-served, not refetched').toBe(true)
      expect(page.pending, 'the batch stays pending under regression').toBe(true)
      expect(page.batchId, 'the re-served identity is the ORIGINAL batch').toBe(batchIdBefore)
      expect(JSON.stringify(page.entries), 'the re-served refs are the old pending refs').toBe(refsBefore)
      const row = await readConsumer(sandbox, scope, teamId)
      expect(row?.needsResync, 'the regression must be durably explicit').toBe(true)
      expect(row?.sourceRegression, 'the regression watermark is durable').toBeTruthy()
      expect(row!.sourceRegression!.cursorSequence, 'the cursor stayed put').toBe(cursor)
      expect(row!.cursorSequence).toBe(cursor)
      expect(row?.pendingBatch?.batchId, 'the pending batch stays put under regression').toBe(batchIdBefore)
      expect(JSON.stringify(row?.pendingBatch?.refs), 'pending refs are never evicted').toBe(refsBefore)
    } finally {
      await disposeRestartComposition(second)
    }
  }, 60_000)

  it('an authorization change or abort inside the real source-read window fences the consumer write itself (QA-③)', async () => {
    const sandbox = await freshSandbox()
    const mounted = await mountSkillsComposition(sandbox)
    try {
      const { root, teamId } = await createSkillsTeam(mounted, sandbox)
      const scope = mounted.ctx.agentSwarm.scopeOf(root)
      for (let index = 0; index < 2; index += 1) await createSkillsTask(mounted.ctx, root, `fence-task-${index}`, `Fence work fact ${index}`)
      await mountSkillsModule(mounted.ctx, { management: [{ scope, teamId }] }, mounted.fibers)
      const module = skillsModule(mounted.ctx)
      let page = await module.syncWorkActivity(scope, teamId)
      while (page.hasMore) page = await module.syncWorkActivity(scope, teamId)
      const before = JSON.stringify(await readConsumer(sandbox, scope, teamId))
      expect(before, 'the drained consumer is durable').not.toBe('undefined')

      // Un-drained work for BOTH barrier phases below: without a pending
      // page the sync path holds no consumer write to fence. (Each fenced
      // phase re-asserts the same unchanged baseline.)
      for (let index = 0; index < 2; index += 1) await createSkillsTask(mounted.ctx, root, `fence-backlog-${index}`, `Fence backlog fact ${index}`)

      // Abort landing through the call BEFORE it starts: rejected up front.
      const controller = new AbortController()
      controller.abort()
      const aborted = await module.syncWorkActivity(scope, teamId, { signal: controller.signal })
        .then(() => undefined, (error: unknown) => error as Error & { code?: string })
      expect(aborted, 'an aborted consumption must not resolve').toBeDefined()
      expect(JSON.stringify(await readConsumer(sandbox, scope, teamId)), 'the abort fence persisted no consumer movement').toBe(before)

      // Abort landing INSIDE the ENTERED/RELEASED barrier — after the real
      // aggregate read returned and before the queued consumer commit: the
      // signal fence at the official update callback must block the write.
      const barrier = installSkillsSourceReadBarrier(scope)
      try {
        barrier.arm()
        const mid = new AbortController()
        const inFlightAbort = module.syncWorkActivity(scope, teamId, { signal: mid.signal })
          .then(() => undefined, (error: unknown) => error as Error & { code?: string })
        await barrier.entered
        mid.abort()
        barrier.release()
        const abortedMid = await inFlightAbort
        expect(abortedMid, 'an abort landing inside the read window must reject the consumption').toBeDefined()
        expect(JSON.stringify(await readConsumer(sandbox, scope, teamId)), 'the post-IO abort fence persisted no consumer movement').toBe(before)
      } finally {
        barrier.restore()
      }

      // Revocation landing INSIDE the same barrier (post-IO, pre-commit): the
      // five-way fence blocks the page commit; nothing advances.
      const revokeBarrier = installSkillsSourceReadBarrier(scope)
      try {
        revokeBarrier.arm()
        const inFlight = module.syncWorkActivity(scope, teamId)
        await revokeBarrier.entered
        module.revokeManagement(scope, teamId)
        revokeBarrier.release()
        const revoked = await inFlight.then(() => undefined, (error: unknown) => error as Error & { code?: string })
        expect(revoked, 'a post-IO revocation must reject the consumption').toBeDefined()
        expect([revoked!.code ?? '', revoked!.message ?? ''].join(' ')).toMatch(/SKILLS_REVOKED|SKILLS_UNAUTHORIZED/)
        expect(JSON.stringify(await readConsumer(sandbox, scope, teamId)), 'the revocation fence persisted no consumer movement').toBe(before)
      } finally {
        revokeBarrier.restore()
      }
    } finally {
      await disposeRestartComposition(mounted)
    }
  }, 60_000)

  it('a retention gap ahead of the cursor is recorded explicitly', async () => {
    const sandbox = await freshSandbox()
    const mounted = await mountSkillsComposition(sandbox)
    let scope = ''
    let teamId = ''
    try {
      const { root, teamId: created } = await createSkillsTeam(mounted, sandbox)
      teamId = created
      scope = mounted.ctx.agentSwarm.scopeOf(root)
      for (let index = 0; index < 3; index += 1) await createSkillsTask(mounted.ctx, root, `gap-task-${index}`, `Gap work fact ${index}`)
    } finally {
      await disposeRestartComposition(mounted)
    }
    await craftTeamOnce(sandbox, teamId, team => {
      const activity = workActivityOf(team)
      expect(activity, 'the aggregate must carry retained workActivity').toBeTruthy()
      // Drop the two oldest retained entries WITHOUT touching nextSequence:
      // the retention floor jumps past an unconsumed cursor region.
      activity!.entries = activity!.entries.filter(entry => entry.sequence > 2)
    })

    const second = await mountSkillsComposition(sandbox)
    try {
      await mountSkillsModule(second.ctx, { management: [{ scope, teamId }] }, second.fibers)
      const page = await skillsModule(second.ctx).syncWorkActivity(scope, teamId)
      expect(page.gaps.some(gap => gap.fromSequence === 1 && gap.toSequence >= 2),
        `a lost head must surface as an explicit gap, got: ${JSON.stringify(page.gaps)}`).toBe(true)
      expect(page.needsResync, 'a gap demands resync explicitly on the first slice').toBe(true)
      expect(page.entries, 'the first slice STOPS over a broken window instead of rebuilding a cursor').toHaveLength(0)
      const row = await readConsumer(sandbox, scope, teamId)
      expect(row?.gaps.length, 'the gap is durable').toBeGreaterThan(0)
      const again = await skillsModule(second.ctx).syncWorkActivity(scope, teamId)
      expect(again.needsResync, 'an ordinary read can NEVER wash the outstanding resync away').toBe(true)
      expect(again.gaps.length, 'the outstanding gap is not duplicated or silently dropped').toBe(row!.gaps.length)
    } finally {
      await disposeRestartComposition(second)
    }
  }, 60_000)

  it('a cold-replaced retained ID is a conflict on the next normal read: cursor, pending batch and anchors all stay put', async () => {
    const sandbox = await freshSandbox()
    const mounted = await mountSkillsComposition(sandbox)
    let scope = ''
    let teamId = ''
    let batchId = ''
    let cursor = 0
    let targetSequence = 0
    let originalId = ''
    let anchorJson = ''
    try {
      const { root, teamId: created } = await createSkillsTeam(mounted, sandbox)
      teamId = created
      scope = mounted.ctx.agentSwarm.scopeOf(root)
      for (let index = 0; index < 3; index += 1) await createSkillsTask(mounted.ctx, root, `swap-task-${index}`, `Swap work fact ${index}`)
      await mountSkillsModule(mounted.ctx, { management: [{ scope, teamId }] }, mounted.fibers)
      const first = await skillsModule(mounted.ctx).syncWorkActivity(scope, teamId)
      expect(first.batchId, 'the batch is captured durably').toBeTruthy()
      batchId = first.batchId!
      cursor = first.cursorSequence
      const row = await readConsumer(sandbox, scope, teamId)
      anchorJson = JSON.stringify(row?.anchors)
      expect(row?.anchors.length, 'observed seq-ID anchors are durable').toBe(first.entries.length)
      targetSequence = first.entries[0]!.sequence
      originalId = first.entries[0]!.id
    } finally {
      await disposeRestartComposition(mounted)
    }

    // Replace the REAL durable ID of one retained sequence, inside the
    // source's retention window, while leaving the consumer bytes untouched.
    await craftTeamOnce(sandbox, teamId, team => {
      const activity = workActivityOf(team)
      expect(activity, 'the aggregate must carry retained workActivity').toBeTruthy()
      const entry = activity!.entries.find(candidate => candidate.sequence === targetSequence)
      expect(entry, 'the target sequence is still retained').toBeTruthy()
      entry!.id = `injected-${targetSequence}-replaced`
    })

    const second = await mountSkillsComposition(sandbox)
    try {
      await mountSkillsModule(second.ctx, { management: [{ scope, teamId }] }, second.fibers)
      const module = skillsModule(second.ctx)
      const page = await module.syncWorkActivity(scope, teamId)
      expect(page.conflicts.some(conflict => conflict.sequence === targetSequence
        && conflict.expectedEventId === originalId
        && conflict.actualEventId === `injected-${targetSequence}-replaced`),
      `the replaced ID must surface as an explicit conflict, got: ${JSON.stringify(page.conflicts)}`).toBe(true)
      expect(page.needsResync, 'a replaced ID demands resync').toBe(true)
      const after = await readConsumer(sandbox, scope, teamId)
      expect(after?.cursorSequence, 'the cursor STAYS at the old tail').toBe(cursor)
      expect(after?.pendingBatch?.batchId, 'the pending batch stays put — the new ID is never adopted').toBe(batchId)
      expect(JSON.stringify(after?.anchors), 'observed anchors keep the original identities').toBe(anchorJson)
      const secondPage = await module.syncWorkActivity(scope, teamId)
      expect(secondPage.needsResync, 'the conflict is sticky across ordinary reads').toBe(true)
      expect(secondPage.conflicts.length, 'repeated reads dedup by stable identity').toBe(after!.conflicts.length)
    } finally {
      await disposeRestartComposition(second)
    }
  }, 60_000)

  it('an archived source is explicit terminal and a missing source is explicit missing', async () => {
    const sandbox = await freshSandbox()
    const mounted = await mountSkillsComposition(sandbox)
    let scope = ''
    let teamId = ''
    try {
      const { root, teamId: created } = await createSkillsTeam(mounted, sandbox)
      teamId = created
      scope = mounted.ctx.agentSwarm.scopeOf(root)
      await createSkillsTask(mounted.ctx, root, 'arch-task', 'Archived-source work fact')
      await mountSkillsModule(mounted.ctx, { management: [{ scope, teamId }] }, mounted.fibers)
      await skillsModule(mounted.ctx).syncWorkActivity(scope, teamId)
    } finally {
      await disposeRestartComposition(mounted)
    }

    await craftTeamOnce(sandbox, teamId, team => {
      team.phase = 'archived'
    })
    const second = await mountSkillsComposition(sandbox)
    try {
      await mountSkillsModule(second.ctx, { management: [{ scope, teamId }] }, second.fibers)
      const module = skillsModule(second.ctx)
      const page = await module.syncWorkActivity(scope, teamId)
      expect(page.sourceState, 'an archived Team reads as archived, not missing').toBe('archived')
      expect((await readConsumer(sandbox, scope, teamId))?.sourceState).toBe('archived')
      const again = await module.syncWorkActivity(scope, teamId)
      expect(again.sourceState, 'archived stays terminal').toBe('archived')
    } finally {
      await disposeRestartComposition(second)
    }

    // The aggregate DEPARTS its scope: `workspace` lives on the official
    // TeamRecord envelope (src/storage/team-spec.ts), never inside the Team
    // state — mutating the correct record layer is the only legal way.
    expect(await craftEnvelope(sandbox, teamId, row => {
      row.workspace = join(sandbox, 'gone')
    }), 'the envelope mutation must land on exactly the one record').toBe(1)
    const third = await mountSkillsComposition(sandbox)
    try {
      await mountSkillsModule(third.ctx, { management: [{ scope, teamId }] }, third.fibers)
      const page = await skillsModule(third.ctx).syncWorkActivity(scope, teamId)
      expect(page.sourceState, 'a departed aggregate reads as missing').toBe('missing')
      const row = await readConsumer(sandbox, scope, teamId)
      expect(row?.sourceState).toBe('missing')
      expect(row?.needsResync, 'missing is a resync-grade condition, never caught-up').toBe(true)
    } finally {
      await disposeRestartComposition(third)
    }
  }, 90_000)
})
