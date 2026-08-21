/**
 * Real-composition tests for the Jiuwen node-type mapping over the Team task
 * DAG (M2-4, issue #78): the five SwarmFlow node kinds compile to plain
 * `createTask`/`blockedBy` composition sugar whose only authority is the
 * board. Tree: AgentLoop + official durable stack + continuable in-process
 * members + the swarm plugin in default adaptive mode (the mapping is
 * mode-agnostic and needs no bridge). Members are real continuable subagents
 * whose gated LLM adapter parses the Team assignment frame and answers with
 * a real `agent_swarm_submit_task` tool call (embedding pipeline artifacts
 * received through Team mail). Lessons 28/29 discipline: `vi.waitFor`
 * timeouts are 15s and every case carries an explicit budget of at least
 * 60s. Scenario 33 of the docs/08 §3 matrix is proven here; mapping table
 * and fault-form correspondence:
 * docs/development/2026-08-21-m2d-node-mapping-design.md.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { resolveChildDepth, SubagentDepthError } from '@deepseek-ai/dsh-subagent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as AgentSwarm from '../src/index.js'
import { applyNodePlan, compileNodePlan } from '../src/index.js'
import type { NodePlan } from '../src/index.js'
import {
  expectDomainCode,
  mountNodeComposition,
  readyOf,
  settleFlow,
  setUpTeam,
  SIGNAL,
  taskOf,
  type NodeComposition,
} from './helpers/node-composition.js'

describe('Jiuwen node-type mapping over the Team task DAG (M2-4, issue #78)', () => {
  const sandboxes: string[] = []
  const compositions: NodeComposition[] = []

  afterEach(async () => {
    for (const composition of compositions.splice(0)) {
      composition.adapter.open()
      for (const fiber of composition.fibers.toReversed()) await fiber.dispose().catch(() => undefined)
    }
    await Promise.all(sandboxes.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
  })

  it('scenario 33: phase nodes compile to the dependency chain; a failed stage holds it and rework releases it', { timeout: 120_000 }, async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-node-phase-'))
    sandboxes.push(sandbox)
    const composition = await mountNodeComposition(sandbox)
    compositions.push(composition)
    const teamId = await setUpTeam(composition, ['m1'])
    const plan: NodePlan = {
      name: 'phase-chain',
      description: 'Two phases: a fan-out stage, then a joining stage.',
      phases: [
        { title: 'prepare', nodes: [{ kind: 'parallel', label: 'prep-fan', items: [
          { subject: 'Prepare inputs', description: 'Prepare the input material.' },
          { subject: 'Prepare outline', description: 'Prepare the outline.' },
        ] }] },
        { title: 'assemble', nodes: [{ kind: 'task', subject: 'Assemble report', description: 'Assemble the final report.' }] },
      ],
    }
    const applied = await applyNodePlan(composition.ctx.agentSwarm, { agent: composition.lead, signal: SIGNAL }, plan)
    const prepA = applied.tasks.get('k1')!
    const prepB = applied.tasks.get('k2')!
    const assemble = applied.tasks.get('k3')!

    // The phase boundary IS the dependency chain: the joining stage's task
    // names BOTH fan-out tasks as blockers; the fan-out peers share no edges.
    expect(prepA.blockedBy).toEqual([])
    expect(prepB.blockedBy).toEqual([])
    expect(assemble.blockedBy).toEqual([prepA.id, prepB.id])
    expect(await readyOf(composition, teamId, assemble.id)).toBe(false)

    // Fault path: the first review of "Prepare inputs" is REJECTED — the
    // stage fails, the chain holds (assemble stays pending, unready), and
    // the board returns the task to pending for rework.
    composition.adapter.submit = true
    await vi.waitFor(async () => {
      composition.adapter.open()
      const task = await taskOf(composition, teamId, prepA.id)
      expect(task.status).toBe('submitted')
    }, { timeout: 15_000 })
    const submitted = await taskOf(composition, teamId, prepA.id)
    await composition.ctx.agentSwarm.reviewTask(
      { agent: composition.lead, signal: SIGNAL },
      {
        taskId: prepA.id,
        expectedRevision: submitted.revision,
        attemptId: submitted.currentAttemptId!,
        decision: 'reject',
        diagnostic: 'stage failed: rework the inputs',
      },
    )
    await vi.waitFor(async () => {
      const task = await taskOf(composition, teamId, prepA.id)
      expect(task.status).toBe('pending')
    }, { timeout: 15_000 })
    const heldAssemble = await taskOf(composition, teamId, assemble.id)
    expect(heldAssemble.status).toBe('pending')
    expect(await readyOf(composition, teamId, assemble.id)).toBe(false)
    let snapshot = await composition.domain.snapshot(composition.scope, AgentSwarm.TeamId(teamId), composition.lead.id)
    expect(snapshot.team.budget.usedRetries).toBe(1)

    // Rework: the scheduler reassigns, the member resubmits, acceptance
    // completes the stage and releases the joining task.
    await settleFlow(composition, teamId, [prepA.id, prepB.id, assemble.id], () => ({ decision: 'accept' }))
    const finished = await taskOf(composition, teamId, assemble.id)
    expect(finished.status).toBe('completed')
    expect(finished.output).toContain('Node member output')
    snapshot = await composition.domain.snapshot(composition.scope, AgentSwarm.TeamId(teamId), composition.lead.id)
    expect(snapshot.team.tasks.find(task => task.id === assemble.id)?.status).toBe('completed')
  })

  it('parallel fan-out rides the member/mailbox quotas as its only backpressure', { timeout: 120_000 }, async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-node-parallel-'))
    sandboxes.push(sandbox)
    const composition = await mountNodeComposition(sandbox, { maxMembers: 2 })
    compositions.push(composition)
    const teamId = await setUpTeam(composition, ['m1', 'm2'])

    // Roster quota (trap 3): the third member is refused by the board.
    await expectDomainCode(
      composition.ctx.agentSwarm.addMember({ agent: composition.lead, signal: SIGNAL }, { name: 'm3', role: 'over quota' }),
      'TEAM_MEMBER_LIMIT',
    )

    const plan: NodePlan = {
      name: 'parallel-fanout',
      description: 'Four fan-out tasks over two members.',
      phases: [{
        title: 'fan',
        nodes: [{
          kind: 'parallel',
          label: 'quad',
          items: [1, 2, 3, 4].map(n => ({ subject: `Fan item ${n}`, description: `Fan-out work item ${n}.` })),
        }],
      }],
    }
    const applied = await applyNodePlan(composition.ctx.agentSwarm, { agent: composition.lead, signal: SIGNAL }, plan)
    const itemIds = ['k1', 'k2', 'k3', 'k4'].map(key => applied.tasks.get(key)!.id)
    for (const task of applied.tasks.values()) expect(task.blockedBy).toEqual([])

    // The builder created ALL four tasks upfront (no admission of its own);
    // the board seats at most one open task per member. Release the members'
    // parked join turns ONCE (they go idle and become schedulable — the F10
    // live-status filter), then let the assignment turns park: exactly two
    // tasks run and two wait pending.
    composition.adapter.submit = false
    composition.adapter.open()
    await vi.waitFor(async () => {
      const snapshot = await composition.domain.snapshot(composition.scope, AgentSwarm.TeamId(teamId), composition.lead.id)
      const inProgress = snapshot.team.tasks.filter(task => task.status === 'in_progress')
      expect(inProgress).toHaveLength(2)
    }, { timeout: 15_000 })
    const waiting = await composition.domain.snapshot(composition.scope, AgentSwarm.TeamId(teamId), composition.lead.id)
    expect(waiting.team.tasks.filter(task => task.status === 'pending')).toHaveLength(2)

    // Release submissions and accept every arriving submission: the held
    // tasks admit only as members free up — the sampled in-flight peak never
    // exceeds the member count (the board's fence, not builder logic).
    composition.adapter.submit = true
    const { peakInFlight } = await settleFlow(composition, teamId, itemIds, () => ({ decision: 'accept' }))
    expect(peakInFlight).toBeLessThanOrEqual(2)
    for (const taskId of itemIds) {
      const task = await taskOf(composition, teamId, taskId)
      expect(task.status).toBe('completed')
    }
  })

  it('pipeline chains stages per item with zero cross-item edges; artifacts ride task output plus Team mail', { timeout: 120_000 }, async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-node-pipeline-'))
    sandboxes.push(sandbox)
    const composition = await mountNodeComposition(sandbox)
    compositions.push(composition)
    const teamId = await setUpTeam(composition, ['m1', 'm2'])
    const plan: NodePlan = {
      name: 'pipeline-two-items',
      description: 'Two items, two stages each.',
      phases: [{
        title: 'flow',
        nodes: [{
          kind: 'pipeline',
          label: 'dual',
          items: [
            { stages: [
              { subject: 'A stage 1', description: 'Produce the A artifact.' },
              { subject: 'A stage 2', description: 'Consume the A artifact.' },
            ] },
            { stages: [
              { subject: 'B stage 1', description: 'Produce the B artifact.' },
              { subject: 'B stage 2', description: 'Consume the B artifact.' },
            ] },
          ],
        }],
      }],
    }
    const applied = await applyNodePlan(composition.ctx.agentSwarm, { agent: composition.lead, signal: SIGNAL }, plan)
    const a1 = applied.tasks.get('k1')!
    const a2 = applied.tasks.get('k2')!
    const b1 = applied.tasks.get('k3')!
    const b2 = applied.tasks.get('k4')!

    // Per-item chains only: stage 2 names exactly its own item's stage 1 —
    // the barrier-free pipeline shape (no cross-item edges anywhere).
    expect(a1.blockedBy).toEqual([])
    expect(b1.blockedBy).toEqual([])
    expect(a2.blockedBy).toEqual([a1.id])
    expect(b2.blockedBy).toEqual([b1.id])
    // The applier resolved the symbolic artifact reference to the REAL
    // upstream task id inside the stage-2 description.
    expect(a2.description).toContain(a1.id)
    expect(a2.description).not.toContain('{upstream:')

    // Relay the artifact through QUIET Team mail up front: quiet mail is
    // durable, never cold-resumes anyone (F13), and lands in the member's
    // conversation from its next turns on — so it is present in the history
    // the stage-2 assignee's turn builds on. The durable artifact itself is
    // the stage-1 task's board output; the mail is the explicit handoff leg.
    for (const member of ['m1', 'm2']) {
      await composition.ctx.agentSwarm.sendMessage(
        { agent: composition.lead, signal: SIGNAL },
        member,
        `PIPELINE-ARTIFACT:alpha-42 produced by ${a1.id}`,
        'quiet',
      )
    }

    composition.adapter.submit = true

    const { peakInFlight } = await settleFlow(composition, teamId, [a1.id, a2.id, b1.id, b2.id], () => ({ decision: 'accept' }))
    expect(peakInFlight).toBeLessThanOrEqual(2)

    // The durable artifact is the completed stage-1 task's board output; the
    // stage-2 submission embedded the marker relayed through Team mail.
    const a1Done = await taskOf(composition, teamId, a1.id)
    expect(a1Done.output).toContain(a1.id)
    const a2Done = await taskOf(composition, teamId, a2.id)
    expect(a2Done.output).toContain('consuming artifact [alpha-42]')
    const b2Done = await taskOf(composition, teamId, b2.id)
    expect(b2Done.status).toBe('completed')
  })

  it('nested nodes reuse the F11 self-Team face, bounded by ambiguity and the depth cap', { timeout: 120_000 }, async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-node-nested-'))
    sandboxes.push(sandbox)
    const composition = await mountNodeComposition(sandbox)
    compositions.push(composition)
    const teamId = await setUpTeam(composition, ['m1'])
    const plan: NodePlan = {
      name: 'nested-composition',
      description: 'One nested node: the assignee self-founds a sub-Team.',
      phases: [{
        title: 'delegate',
        nodes: [{ kind: 'nested', subject: 'Run the survey as your own Team', description: 'Execute the survey work through a self-founded sub-Team.' }],
      }],
    }
    const applied = await applyNodePlan(composition.ctx.agentSwarm, { agent: composition.lead, signal: SIGNAL }, plan)
    const nested = applied.tasks.get('k1')!
    expect(nested.description).toContain('found your OWN sub-Team')

    // The scheduler assigns the nested task after the member's parked join
    // turn is released once (idle = schedulable); the assignment turn then
    // parks again — the claim is already committed on the board.
    composition.adapter.submit = false
    composition.adapter.open()
    let memberAgent: Agent | undefined
    await vi.waitFor(async () => {
      const task = await taskOf(composition, teamId, nested.id)
      expect(task.status).toBe('in_progress')
      expect(task.ownerSessionId).toBeDefined()
      memberAgent = composition.ctx.agents.get(SessionId(task.ownerSessionId!))
      expect(memberAgent).toBeDefined()
    }, { timeout: 15_000 })

    // The F11 face: the member's own session founds a sub-Team in the same
    // scope (createTeam has no membership precondition) — the session is now
    // member of the parent and captain of the child.
    const subTeam = await composition.ctx.agentSwarm.create(
      { agent: memberAgent!, signal: SIGNAL },
      'nested sub-team',
      'The nested composition body.',
    )
    expect(subTeam.captainSessionId).toBe(memberAgent!.id)

    // Ambiguity bound: every IMPLICIT membership face of the dual-active
    // session now fails loud (the nested composition must be explicit).
    await expectDomainCode(
      composition.ctx.agentSwarm.addMember({ agent: memberAgent!, signal: SIGNAL }, { name: 'sub-worker', role: 'nested worker' }),
      'TEAM_MEMBERSHIP_AMBIGUOUS',
    )
    await expectDomainCode(
      composition.ctx.agentSwarm.status({ agent: memberAgent!, signal: SIGNAL }),
      'TEAM_MEMBERSHIP_AMBIGUOUS',
    )

    // Depth bound: the member (depth 1) cannot spawn its own child under the
    // configured cap — the official one-level nesting backstop.
    expect(() => resolveChildDepth(memberAgent!, 1)).toThrow(SubagentDepthError)

    // The sub-Team folds through the EXPLICIT authority (teamId-addressed
    // domain port), then the member submits the parent task normally.
    await composition.domain.archiveTeam(composition.scope, AgentSwarm.TeamId(subTeam.id), memberAgent!.id, 'nested composition folded')
    composition.adapter.submit = true
    await settleFlow(composition, teamId, [nested.id], () => ({ decision: 'accept' }))
    const done = await taskOf(composition, teamId, nested.id)
    expect(done.status).toBe('completed')
    // The archived sub-team remains readable through the F14 read face.
    const subSnapshot = await composition.domain.snapshot(composition.scope, AgentSwarm.TeamId(subTeam.id), memberAgent!.id)
    expect(subSnapshot.team.phase).toBe('archived')
  })

  it('human nodes gate at the review transaction: refusal reworks, approval completes and releases the flow', { timeout: 120_000 }, async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-node-human-'))
    sandboxes.push(sandbox)
    const composition = await mountNodeComposition(sandbox)
    compositions.push(composition)
    const teamId = await setUpTeam(composition, ['m1'])
    const plan: NodePlan = {
      name: 'human-gate',
      description: 'Prepare, ask the human, then publish.',
      phases: [
        { title: 'prepare', nodes: [{ kind: 'task', subject: 'Draft the release note', description: 'Draft the release note.' }] },
        { title: 'approve', nodes: [{ kind: 'human', question: 'Publish the release note as drafted?', context: 'The draft rides this task chain.' }] },
        { title: 'publish', nodes: [{ kind: 'task', subject: 'Publish the release note', description: 'Publish the approved note.' }] },
      ],
    }
    const applied = await applyNodePlan(composition.ctx.agentSwarm, { agent: composition.lead, signal: SIGNAL }, plan)
    const draft = applied.tasks.get('k1')!
    const gate = applied.tasks.get('k2')!
    const publish = applied.tasks.get('k3')!

    // The compiled human node: the question is task data, the completion
    // criteria name the review-gate human leg, and the applied plan exposes
    // the review hook with the resolved task id.
    expect(gate.subject).toContain('Publish the release note as drafted?')
    expect(gate.description).toContain('Question: Publish the release note as drafted?')
    expect(applied.reviewGates).toHaveLength(1)
    expect(applied.reviewGates[0]).toMatchObject({ taskId: gate.id, question: 'Publish the release note as drafted?' })
    expect(publish.blockedBy).toEqual([gate.id])

    // Refusal leg: the first gate submission is REJECTED — the human said
    // no; the task reworks (pending + retry charge) and publish stays held
    // until the approved resubmission releases it.
    composition.adapter.submit = true
    await settleFlow(composition, teamId, [gate.id, publish.id], (taskId, round) => {
      if (taskId === gate.id && round === 1) return { decision: 'reject', diagnostic: 'refused: tighten the note' }
      if (taskId === gate.id) return { decision: 'accept', diagnostic: 'approved: publish as drafted' }
      return { decision: 'accept' }
    })

    const gateDone = await taskOf(composition, teamId, gate.id)
    expect(gateDone.status).toBe('completed')
    const publishDone = await taskOf(composition, teamId, publish.id)
    expect(publishDone.status).toBe('completed')
    const snapshot = await composition.domain.snapshot(composition.scope, AgentSwarm.TeamId(teamId), composition.lead.id)
    expect(snapshot.team.budget.usedRetries).toBe(1)
    expect(snapshot.team.tasks.find(task => task.id === draft.id)?.status).toBe('completed')
  })

  it('compiles malformed plans loud and emits topological order with symbolic artifacts', () => {
    const base = { name: 'validation', description: 'Compiler validation.' }
    expect(() => compileNodePlan({ ...base, phases: [] })).toThrow(AgentSwarm.TeamDomainError)
    expect(() => compileNodePlan({ ...base, phases: [{ title: 'p', nodes: [] }] })).toThrow(/nodes/)
    expect(() => compileNodePlan({
      ...base,
      phases: [{ title: 'p', nodes: [{ kind: 'parallel' as const, label: 'empty', items: [] }] }],
    })).toThrow(/items/)
    expect(() => compileNodePlan({
      ...base,
      phases: [{ title: 'p', nodes: [{ kind: 'pipeline' as const, label: 'empty', items: [{ stages: [] }] }] }],
    })).toThrow(/stages/)
    expect(() => compileNodePlan({
      ...base,
      phases: [{ title: 'p', nodes: [{ kind: 'human' as const, question: '  ' }] }],
    })).toThrow(/question/)
    expect(() => compileNodePlan({
      ...base,
      phases: [{ title: 'p', nodes: [{ kind: 'critical' as unknown as 'task', subject: 'x', description: 'y' }] }],
    })).toThrow(/task\|parallel\|pipeline\|nested\|human/)

    const compiled = compileNodePlan({
      name: 'order',
      description: 'Topological emission order.',
      phases: [
        { title: 'one', nodes: [
          { kind: 'parallel', label: 'fan', items: [{ subject: 'a', description: 'a' }, { subject: 'b', description: 'b' }] },
        ] },
        { title: 'two', nodes: [
          { kind: 'pipeline', label: 'pipe', items: [{ stages: [{ subject: 's1', description: 's1' }, { subject: 's2', description: 's2' }] }] },
          { kind: 'human', question: 'ship it?' },
        ] },
      ],
    })
    // Topological: every dependency's key precedes its dependents, keys are
    // unique, and the pipeline's stage-2 description carries the symbolic
    // upstream reference the applier resolves to the real task id.
    const positions = new Map(compiled.ops.map((op, index) => [op.key, index]))
    expect(new Set(positions.keys()).size).toBe(compiled.ops.length)
    for (const op of compiled.ops) {
      for (const dependency of op.input.blockedBy) {
        expect(positions.get(dependency)!).toBeLessThan(positions.get(op.key)!)
      }
    }
    expect(compiled.ops.map(op => op.key)).toEqual(['k1', 'k2', 'k3', 'k4', 'k5'])
    expect(compiled.ops[3]!.input.description).toContain('{upstream:k3}')
    expect(compiled.phases.get('one')).toEqual(['k1', 'k2'])
    expect(compiled.phases.get('two')).toEqual(['k3', 'k4', 'k5'])
    expect(compiled.reviewGates).toEqual([{ taskKey: 'k5', question: 'ship it?' }])
  })
})
