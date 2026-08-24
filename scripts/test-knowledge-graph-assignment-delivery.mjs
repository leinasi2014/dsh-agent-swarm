import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KnowledgeGraphError } from './knowledge-graph/diagnostics.mjs'
import { extractAssignmentDeliveryFacts, validateAssignmentDeliveryFacts } from './knowledge-graph/extractors/assignment-delivery.mjs'
import { validateManifestSemantics } from './knowledge-graph/model.mjs'
import {
  buildAssignmentDeliveryCandidate,
  reconcileAssignmentDeliverySlice,
} from './knowledge-graph/reconcile-assignment-delivery.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const { facts, sourceFacts, manifest, slice } = await buildAssignmentDeliveryCandidate(root)

function expectManifestCode(code, mutate) {
  const candidate = structuredClone(manifest)
  mutate(candidate)
  assert.throws(
    () => reconcileAssignmentDeliverySlice(facts, sourceFacts, candidate),
    error => error instanceof KnowledgeGraphError && error.code === code,
  )
}

function node(candidate, id) {
  const value = candidate.nodes.find(item => item.id === id)
  assert(value, `missing fixture node ${id}`)
  return value
}

function edge(candidate, id) {
  const value = candidate.edges.find(item => item.id === id)
  assert(value, `missing fixture edge ${id}`)
  return value
}

async function expectSourceCode(code, file, replace, replacement, official = false) {
  const base = official ? resolve(root, '../../..') : root
  const source = await readFile(resolve(base, file), 'utf8')
  const changed = source.replace(replace, replacement)
  assert.notEqual(changed, source, `source fixture did not match ${file}`)
  const option = official ? { officialSourceOverrides: { [file]: changed } } : { sourceOverrides: { [file]: changed } }
  await assert.rejects(
    () => extractAssignmentDeliveryFacts(root, option),
    error => error instanceof KnowledgeGraphError && error.code === code,
  )
}

const summary = reconcileAssignmentDeliverySlice(facts, sourceFacts, manifest)
assert.deepEqual({ nodes: summary.nodeCount, edges: summary.edgeCount }, { nodes: 63, edges: 139 })
assert.equal(facts.callables.length, 14)
assert.equal(facts.official.callables.length, 6)
assert.equal(facts.digest, 'd8441548137dac2ae42ff1ca38572ee397cdabf99943d817bcbd879ad8e3aff3')
assert.deepEqual(facts.bounds, { followupTimeoutMs: 30000, waitTimeoutMs: 30000, visibilityTimeoutMs: 30000, claimGraceMs: 5000 })
assert.equal(slice.nodes.find(item => item.id === 'provider:official-subagent-followup').security.mutation, 'external-effect')
assert.equal(node(manifest, 'service:assignment-scheduling').ownerAuthority.id, 'domain:agent-swarm')
assert.equal(node(manifest, 'service:assignment-scheduling').security.authoritySource.id, 'official-authority:subagent')
assert.equal(node(manifest, 'service:assignment-scheduling').maturity.verification.state, 'static')
assert.deepEqual(node(manifest, 'guard:official-live-direct-parent-admission').ownerAuthority, { id: 'official-authority:subagent', kind: 'official-authority' })
assert.deepEqual(node(manifest, 'guard:official-live-direct-parent-admission').security.authoritySource, { id: 'official-authority:subagent', kind: 'official-authority' })
assert.equal(node(manifest, 'flow-branch:assignment-delivery/admission-rejected').maturity.verification.state, 'static')
assert.equal(node(manifest, 'flow-branch:assignment-delivery/admission-unknown').maturity.verification.state, 'static')
assert.equal(edge(manifest, 'edge:scheduling/calls-followup-rejected').crash.authoritativePostState, 'unchanged')
assert.equal(edge(manifest, 'edge:scheduling/calls-followup-rejected').crash.failureCode, 'SUBAGENT_MESSAGE_NOT_ADMITTED')
assert.equal(edge(manifest, 'edge:scheduling/calls-followup-unknown').crash.authoritativePostState, 'unknown')
assert.equal(edge(manifest, 'edge:scheduling/calls-followup-unknown').crash.retryRule, 'exact-readback-first')
assert.deepEqual(edge(manifest, 'edge:scheduling/calls-ack').crash.expectedBefore.map(item => item.id), [
  'state-predicate:task-current-attempt-present', 'state-predicate:attempt-phase-running',
  'state-predicate:attempt-assignment-reserved', 'state-predicate:session-frame-claimed',
])
assert.deepEqual(edge(manifest, 'edge:scheduling/calls-followup-redelivery').crash.expectedBefore.map(item => item.id), [
  'state-predicate:task-current-attempt-present', 'state-predicate:attempt-phase-running',
  'state-predicate:attempt-assignment-reserved', 'state-predicate:session-frame-absent',
])
for (const state of ['pending', 'unknown']) {
  const recovery = edge(manifest, `edge:recovery/${state}`).crash
  assert.equal(recovery.recoveryMode, 'observe-block')
  assert.deepEqual(recovery.committedAfter, [])
  assert.deepEqual(recovery.recoveryTransactions, [])
  assert.equal(recovery.retryRule, 'exact-readback-first')
  assert.deepEqual(recovery.expectedBefore.map(item => item.id), [
    'state-predicate:task-current-attempt-present', 'state-predicate:attempt-phase-running',
    'state-predicate:attempt-assignment-reserved', `state-predicate:session-frame-${state}`,
  ])
}
assert(edge(manifest, 'edge:claim/mutates-budget'))
assert(edge(manifest, 'edge:claim/transitions-budget-used-requests'))
assert.equal(validateManifestSemantics(root, manifest).nodeCount, manifest.nodes.length)

expectManifestCode('KG_SEMANTIC_AUTHORITY', candidate => {
  node(candidate, 'entity:session-assignment-frame').ownerAuthority = { id: 'domain:agent-swarm', kind: 'domain' }
})
expectManifestCode('KG_SEMANTIC_OWNER', candidate => {
  node(candidate, 'entity:task-attempt').ownerAuthority = { id: 'authority:project-contracts', kind: 'authority' }
})
expectManifestCode('KG_SEMANTIC_PREDICATE', candidate => {
  node(candidate, 'state-predicate:attempt-assignment-reserved').contract.predicate.field.selector = 'status'
})
expectManifestCode('KG_SEMANTIC_PREDICATE', candidate => {
  node(candidate, 'state-predicate:attempt-assignment-reserved').contract.predicate.value = 'delivered'
})
expectManifestCode('KG_SEMANTIC_GUARD', candidate => {
  node(candidate, 'transaction:claim-task').security.guards[0] = { id: 'guard:decoy', kind: 'guard' }
})
expectManifestCode('KG_SEMANTIC_BOUND', candidate => {
  node(candidate, 'service:assignment-scheduling').bounds[0].value = 30001
})
expectManifestCode('KG_SEMANTIC_RETRY', candidate => {
  edge(candidate, 'edge:scheduling/calls-followup-unknown').crash.retryRule = 'blind-retry'
})
expectManifestCode('KG_SEMANTIC_SESSION_READ', candidate => {
  candidate.edges = candidate.edges.filter(item => item.id !== 'edge:scheduling/read-frame-claimed')
})
expectManifestCode('KG_SEMANTIC_RECOVERY', candidate => {
  edge(candidate, 'edge:scheduling/calls-followup-rejected').crash.recoveryTransactions = []
})
expectManifestCode('KG_SEMANTIC_RECOVERY', candidate => {
  edge(candidate, 'edge:scheduling/calls-followup-rejected').crash.recoveryTransactions = [{ id: 'transaction:acknowledge-assignment', kind: 'transaction' }]
})
expectManifestCode('KG_SEMANTIC_RECOVERY_MUTATION', candidate => {
  candidate.edges = candidate.edges.filter(item => item.id !== 'edge:cancel/mutates-task')
})
expectManifestCode('KG_SEMANTIC_RECOVERY_MUTATION', candidate => {
  edge(candidate, 'edge:cancel/mutates-task').to = { id: 'entity:session-assignment-frame', kind: 'entity' }
})
expectManifestCode('KG_SEMANTIC_ORDINAL', candidate => {
  edge(candidate, 'edge:scheduling/calls-followup-unknown').crash.ordinal = 2
})
expectManifestCode('KG_SEMANTIC_DISPOSER', candidate => {
  delete node(candidate, 'provider:official-subagent-followup').lifecycle.disposerOwner
})
expectManifestCode('KG_SEMANTIC_TRACE', candidate => {
  candidate.edges = candidate.edges.filter(item => item.id !== 'edge:flow/documented-core')
})
expectManifestCode('KG_SEMANTIC_CLASSIFICATION', candidate => {
  node(candidate, 'flow:assignment-delivery').classification = 'mechanical'
})
expectManifestCode('KG_SEMANTIC_EDGE_EXTRA', candidate => {
  const decoy = structuredClone(edge(candidate, 'edge:task/team-authority'))
  decoy.id = 'edge:unrelated/reviewed-decoy'
  decoy.anchors[0].selector = 'unrelated-selector-with-no-slice-tag'
  candidate.edges.push(decoy)
})
expectManifestCode('KG_SEMANTIC_RECOVERY_MUTATION', candidate => {
  candidate.edges = candidate.edges.filter(item => item.id !== 'edge:claim/mutates-budget')
})

{
  const proposal = structuredClone(facts)
  proposal.contracts.find(item => item.documentId === 'i1b-v2-effect-ledger-decision').role = 'stable-authority'
  assert.throws(() => validateAssignmentDeliveryFacts(proposal), error => error instanceof KnowledgeGraphError && error.code === 'KG_SEMANTIC_CONTRACT_UNSTABLE')
}

{
  const guardDecoy = structuredClone(facts)
  const rollback = guardDecoy.callables.find(item => item.id.endsWith('#SchedulingPass.rollbackUndeliveredAssignment'))
  rollback.comparisons = rollback.comparisons.filter(item => item !== 'task.currentAttemptId !== attemptId')
  rollback.comparisons.push('task.id === task.id')
  assert.throws(() => validateAssignmentDeliveryFacts(guardDecoy), error => error instanceof KnowledgeGraphError && error.code === 'KG_SEMANTIC_GUARD')
}

await expectSourceCode(
  'KG_SEMANTIC_SOURCE_CALL', 'src/runtime/scheduling.ts',
  '    const frame = assignmentPrompt(team, task, attempt.id, executionRootPath)\n    try {\n      await this.ctx.subagents.followup(',
  '    const localFollowup = async (..._args: unknown[]): Promise<void> => undefined\n    const frame = assignmentPrompt(team, task, attempt.id, executionRootPath)\n    try {\n      await localFollowup(',
)
await expectSourceCode(
  'KG_SEMANTIC_CONTROL_FLOW', 'src/runtime/scheduling.ts',
  '    try {\n      const member = this.ctx.agents.get(SessionId(attempt.memberSessionId))',
  '    if (false) try {\n      const member = this.ctx.agents.get(SessionId(attempt.memberSessionId))',
)
await expectSourceCode(
  'KG_SEMANTIC_CONTROL_FLOW', 'src/runtime/scheduling.ts',
  'member === undefined || !await waitForFrameClaim(this.ctx, member, frame, AbortSignal.timeout(30_000))',
  'member === undefined || (false && !await waitForFrameClaim(this.ctx, member, frame, AbortSignal.timeout(30_000)))',
)
await expectSourceCode(
  'KG_SEMANTIC_CONTROL_FLOW', 'src/runtime/scheduling.ts',
  '    await this.commitAssignmentAcknowledgement(scope, team.id, task, attempt.id)\n  }\n\n  /**\n   * Fold one reserved attempt',
  '    return\n    await this.commitAssignmentAcknowledgement(scope, team.id, task, attempt.id)\n  }\n\n  /**\n   * Fold one reserved attempt',
)
await expectSourceCode(
  'KG_SEMANTIC_CONTROL_FLOW', 'src/runtime/scheduling.ts',
  '    await this.commitAssignmentAcknowledgement(scope, team.id, task, attempt.id)\n  }\n\n  /**\n   * Fold one reserved attempt',
  '    if (false) await this.commitAssignmentAcknowledgement(scope, team.id, task, attempt.id)\n  }\n\n  /**\n   * Fold one reserved attempt',
)
await expectSourceCode(
  'KG_SEMANTIC_CONTROL_FLOW', 'src/runtime/scheduling.ts',
  "    if (visibility === 'claimed') await this.commitAssignmentAcknowledgement(scope, team.id, task, attempt.id)\n    return true",
  "    if (visibility === 'claimed') await this.commitAssignmentAcknowledgement(scope, team.id, task, attempt.id)\n    if (visibility === 'unknown') return false\n    return true",
)
await expectSourceCode(
  'KG_SEMANTIC_ROLLBACK_PROOF', 'src/runtime/scheduling.ts',
  'taskId, task.revision, diagnostic)', 'taskId, task.revision + 1, diagnostic)',
)
await expectSourceCode(
  'KG_SEMANTIC_ROLLBACK_PROOF', 'src/runtime/scheduling.ts',
  '      if (task?.currentAttemptId !== attemptId) return', '      return\n      if (task?.currentAttemptId !== attemptId) return',
)
await expectSourceCode(
  'KG_SEMANTIC_FRAME_PROOF', 'src/runtime/frame-visibility.ts',
  "block.type === 'text' && block.text === frame", "block.type === 'text' && block.text.includes(frame)",
)
await expectSourceCode(
  'KG_SEMANTIC_CONTROL_FLOW', 'src/runtime/scheduling.ts',
  "if (visibility === 'absent') return false", "if (visibility === 'absent') return true",
)
await expectSourceCode(
  'KG_SEMANTIC_CONTROL_FLOW', 'src/runtime/scheduling.ts',
  "    if (visibility === 'claimed') await this.commitAssignmentAcknowledgement(scope, team.id, task, attempt.id)\n    return true",
  "    if (visibility === 'claimed') await this.commitAssignmentAcknowledgement(scope, team.id, task, attempt.id)\n    return false",
)
await expectSourceCode(
  'KG_SEMANTIC_CONTROL_FLOW', 'src/runtime/scheduling.ts',
  '        `assignment delivery failed: ${error instanceof Error ? error.message : String(error)}`,\n      )\n      return',
  '        `assignment delivery failed: ${error instanceof Error ? error.message : String(error)}`,\n      )',
)
await expectSourceCode(
  'KG_SEMANTIC_CONTROL_FLOW', 'src/runtime/frame-visibility.ts',
  "export type FrameVisibility = 'claimed' | 'pending' | 'absent' | 'unknown'",
  "export type FrameVisibility = 'claimed' | 'pending' | 'absent'",
)
await expectSourceCode(
  'KG_SEMANTIC_FRAME_PROOF', 'src/runtime/scheduling.ts',
  'assignmentPrompt(team, task, attempt.id, executionRootPath),',
  'assignmentPrompt(team, task, task.id, executionRootPath),',
)
await expectSourceCode(
  'KG_SEMANTIC_CONTROL_FLOW', 'src/runtime/scheduling.ts',
  '      await this.ctx.subagents.followup(\n        captain,',
  '      await this.ctx.subagents.followup(\n        task as never,',
)
await expectSourceCode(
  'KG_SEMANTIC_CONTROL_FLOW', 'src/runtime/scheduling.ts',
  '        task.id,\n        attempt.id,\n        `assignment delivery failed:',
  '        task.id,\n        task.currentAttemptId!,\n        `assignment delivery failed:',
)
await expectSourceCode(
  'KG_SEMANTIC_ROLLBACK_PROOF', 'src/runtime/scheduling.ts',
  'this.deps.domain().snapshot(scope, teamId, captainId)',
  'this.deps.domain().snapshot(scope, TaskId(taskId), captainId)',
)
await expectSourceCode(
  'KG_SEMANTIC_SOURCE_CALL', 'src/domain/team-domain-board.ts',
  'seated = seatAttempt(team, {', 'seated = seatAttemptDecoy(team, {',
)
await expectSourceCode(
  'KG_SEMANTIC_BUDGET_ATOMIC', 'src/domain/team-domain-board.ts',
  'usedRequests: team.budget.usedRequests + 1', 'usedRequests: team.budget.usedRequests + 0',
)
await expectSourceCode(
  'KG_SEMANTIC_BUDGET_ATOMIC', 'src/domain/team-domain-board.ts',
  '  Object.assign(team, { budget: { ...team.budget, usedRequests: team.budget.usedRequests + 1 } })',
  '  void (team.budget.usedRequests + 1)\n  Object.assign(team, { budget: { ...team.budget, usedRequests: team.budget.usedRequests + 0 } })',
)
await expectSourceCode(
  'KG_SEMANTIC_OFFICIAL_CONTROL_FLOW', 'packages/subagent/subagent/src/continuation.ts',
  '    this.wake(activation)\n    return messageId', '    if (false) this.wake(activation)\n    return messageId', true,
)
await expectSourceCode(
  'KG_SEMANTIC_OFFICIAL_CONTROL_FLOW', 'packages/subagent/subagent/src/continuation.ts',
  '    this.authorizeLineage(\n      parent,\n      activation.childId,\n      activation.handle.agent.session.header.parentSession,\n    )',
  '    void activation.handle.agent.session.header.parentSession', true,
)
await expectSourceCode(
  'KG_SEMANTIC_OFFICIAL_CONTROL_FLOW', 'packages/subagent/subagent/src/continuation.ts',
  '    this.authorizeLineage(parent, childId, loaded.meta.parentSession)',
  '    void loaded.meta.parentSession', true,
)
await expectSourceCode(
  'KG_SEMANTIC_OFFICIAL_CONTROL_FLOW', 'packages/subagent/subagent/src/continuation.ts',
  '      activation.handle.agent.followup(message)', '      void message', true,
)
await expectSourceCode(
  'KG_SEMANTIC_BOUND', 'src/runtime/scheduling.ts',
  "signal: AbortSignal.timeout(30_000) },", "signal: AbortSignal.timeout(30_001) },",
)
await expectSourceCode(
  'KG_SEMANTIC_BOUND', 'src/runtime/scheduling.ts',
  'waitForFrameClaim(this.ctx, member, frame, AbortSignal.timeout(30_000))',
  'waitForFrameClaim(this.ctx, member, frame, AbortSignal.timeout(30_001))',
)
await expectSourceCode(
  'KG_SEMANTIC_BOUND', 'src/runtime/scheduling.ts',
  'AbortSignal.timeout(30_000), `assignment ${attempt.id}`',
  'AbortSignal.timeout(30_001), `assignment ${attempt.id}`',
)
await expectSourceCode(
  'KG_SEMANTIC_BOUND', 'src/runtime/frame-visibility.ts',
  'const WAKEUP_CLAIM_GRACE_MS = 5_000', 'const WAKEUP_CLAIM_GRACE_MS = 5_001',
)
await expectSourceCode(
  'KG_SEMANTIC_FRAME_PROOF', 'src/runtime/prompts.ts',
  'Attempt capability: ${attemptId}', 'Attempt capability: omitted',
)

process.stdout.write(`knowledge graph assignment-delivery fixtures passed (${summary.nodeCount} nodes, ${summary.edgeCount} edges)\n`)
