import { fail } from './diagnostics.mjs'
import { validateAssignmentDeliveryFacts } from './extractors/assignment-delivery.mjs'

const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0
const sourceAuthority = { id: 'authority:source-tree', kind: 'authority' }
const team = { id: 'domain:agent-swarm', kind: 'domain' }
const session = { id: 'official-authority:session', kind: 'official-authority' }
const subagent = { id: 'official-authority:subagent', kind: 'official-authority' }
const contracts = { id: 'authority:project-contracts', kind: 'authority' }

function ref(id, kind) { return { id, kind } }

function maturity(verification = 'static', evidence = []) {
  return {
    implementation: { state: 'implemented', evidence: [] },
    verification: { state: verification, evidence },
    acceptance: { state: 'candidate' },
    availability: { state: 'always-registered', conditions: ['agent-swarm runtime and registered official services'], blockers: [] },
  }
}

function security(owner, mutation = 'none', options = {}) {
  return {
    authoritySource: options.authoritySource ?? owner,
    callerIdentity: options.callerIdentity ?? 'internal-provider',
    mutation,
    dataClasses: options.dataClasses ?? ['team'],
    guards: options.guards ?? [],
    redlines: options.redlines ?? [],
  }
}

function node(id, kind, title, owner, anchors, options = {}) {
  return {
    id, kind, classification: 'reviewed', factAuthority: sourceAuthority, title, anchors,
    ownerAuthority: owner,
    config: { gates: [], defaultState: options.defaultState ?? 'enabled', blockerCodes: [] },
    inject: { required: [], optional: [], provides: [] },
    lifecycle: options.lifecycle ?? {},
    maturity: options.maturity ?? maturity(options.verification ?? 'static', options.evidence ?? []),
    security: options.security ?? security(owner),
    bounds: options.bounds ?? [],
    ...(options.contract === undefined ? {} : { contract: options.contract }),
    tags: options.tags ?? ['assignment-delivery', 'kg1-d1'],
  }
}

function edge(id, type, from, to, anchor, options = {}) {
  return {
    id, type, classification: 'reviewed', from, to, anchors: [anchor],
    ...(options.contract === undefined ? {} : { contract: options.contract }),
    ...(options.crash === undefined ? {} : { crash: options.crash }),
  }
}

function callableMap(facts) { return new Map(facts.callables.map(item => [item.id, item])) }

function sourceAnchor(facts, id, selector) {
  const item = callableMap(facts).get(id)
  if (item === undefined) fail('KG_SEMANTIC_SOURCE_DECLARATION', `missing source anchor ${id}`)
  return { file: item.file, symbol: item.className === null ? item.name : `${item.className}.${item.name}`, selector: `${selector}-${item.semanticDigest.slice(0, 16)}` }
}

function officialAnchor(facts, selector) {
  return { file: 'docs/OFFICIAL_BASELINE.json', selector: `${selector}-${facts.official.commit.slice(0, 12)}-${facts.official.tree.slice(0, 12)}` }
}

function contractAnchor(facts, file, selector, digestKey) {
  return { file, selector: `${selector}-${facts.contractSlices[digestKey].slice(0, 16)}` }
}

function predicate(id, title, entity, selector, operator, value, owner, anchor) {
  return node(id, 'state-predicate', title, owner, [anchor], {
    contract: {
      nodeKind: 'state-predicate',
      predicate: { entity, field: { schema: entity, selector }, operator, ...(value === undefined ? {} : { value }) },
    },
  })
}

function branch(id, title, flow, owner, anchor) {
  return node(id, 'flow-branch', title, owner, [anchor], { contract: { nodeKind: 'flow-branch', flow } })
}

function crash(flow, branchRef, options) {
  return {
    flow, branch: branchRef, ordinal: options.ordinal ?? 0, phase: options.phase,
    durability: options.durability, recoveryMode: options.recoveryMode,
    expectedBefore: options.expectedBefore, committedAfter: options.committedAfter,
    ...(options.checkpoint === undefined ? {} : { checkpoint: options.checkpoint }),
    fences: options.fences, recoveryTransactions: options.recoveryTransactions,
    failureCode: options.failureCode, authoritativePostState: options.authoritativePostState,
    ...(options.idempotency === undefined ? {} : { idempotency: options.idempotency }),
    retryRule: options.retryRule, recoveryOwner: ref('service:assignment-scheduling', 'service'),
  }
}

export function buildAssignmentDeliverySlice(facts, mechanicalInventory) {
  validateAssignmentDeliveryFacts(facts)
  const mechanicalDomain = mechanicalInventory.nodes.find(item => item.id === team.id)
  if (mechanicalDomain === undefined) fail('KG_SEMANTIC_TEAM_DOMAIN', 'mechanical Team domain fact is missing')
  const claimAnchor = sourceAnchor(facts, 'src/domain/team-domain-board.ts#claimTask', 'claim-task')
  const ackAnchor = sourceAnchor(facts, 'src/domain/team-domain-board.ts#acknowledgeAssignment', 'acknowledge-assignment')
  const cancelAnchor = sourceAnchor(facts, 'src/domain/team-domain-board.ts#cancelAttempt', 'cancel-attempt')
  const dispatchAnchor = sourceAnchor(facts, 'src/runtime/scheduling.ts#SchedulingPass.dispatchAssignment', 'dispatch-assignment')
  const rollbackAnchor = sourceAnchor(facts, 'src/runtime/scheduling.ts#SchedulingPass.rollbackUndeliveredAssignment', 'rollback-undelivered')
  const settleAnchor = sourceAnchor(facts, 'src/runtime/scheduling.ts#SchedulingPass.settleReservedAssignment', 'settle-reserved')
  const visibilityAnchor = sourceAnchor(facts, 'src/runtime/frame-visibility.ts#frameVisibility', 'frame-visibility')
  const waitAnchor = sourceAnchor(facts, 'src/runtime/frame-visibility.ts#waitForFrameClaim', 'wait-frame-claim')
  const claimedAnchor = sourceAnchor(facts, 'src/runtime/session-acceptance.ts#messageClaimed', 'message-claimed')
  const seatAnchor = sourceAnchor(facts, 'src/domain/team-domain-board.ts#seatAttempt', 'seat-attempt-budget')
  const flow = ref('flow:assignment-delivery', 'flow')
  const branchRefs = Object.fromEntries(['claim-reserved', 'admission-rejected', 'admission-unknown', 'claimed', 'absent', 'pending', 'unknown'].map(name => [name, ref(`flow-branch:assignment-delivery/${name}`, 'flow-branch')]))
  const scheduling = ref('service:assignment-scheduling', 'service')
  const frameRead = ref('service:assignment-frame-visibility', 'service')
  const continuation = ref('service:official-subagent-continuation', 'service')
  const followup = ref('provider:official-subagent-followup', 'provider')
  const sessionRead = ref('provider:official-session-readback', 'provider')
  const task = ref('entity:team-task', 'entity')
  const attempt = ref('entity:task-attempt', 'entity')
  const budget = ref('entity:team-request-budget', 'entity')
  const budgetState = ref('state:team-budget-used-requests', 'state')
  const frame = ref('entity:session-assignment-frame', 'entity')
  const claimTx = ref('transaction:claim-task', 'transaction')
  const ackTx = ref('transaction:acknowledge-assignment', 'transaction')
  const cancelTx = ref('transaction:cancel-undelivered-assignment', 'transaction')
  const checkpointReserved = ref('checkpoint:attempt-reserved', 'checkpoint')
  const checkpointClaimed = ref('checkpoint:session-frame-claimed', 'checkpoint')
  const checkpointDelivered = ref('checkpoint:attempt-delivered', 'checkpoint')
  const attemptFence = ref('fence:current-attempt-id', 'fence')
  const revisionFence = ref('fence:task-revision', 'fence')
  const frameFence = ref('fence:exact-assignment-frame', 'fence')
  const predicates = {
    taskCurrent: ref('state-predicate:task-current-attempt-present', 'state-predicate'),
    taskPending: ref('state-predicate:task-status-pending', 'state-predicate'),
    attemptRunning: ref('state-predicate:attempt-phase-running', 'state-predicate'),
    attemptReserved: ref('state-predicate:attempt-assignment-reserved', 'state-predicate'),
    attemptDelivered: ref('state-predicate:attempt-assignment-delivered', 'state-predicate'),
    attemptStale: ref('state-predicate:attempt-phase-stale', 'state-predicate'),
    frameClaimed: ref('state-predicate:session-frame-claimed', 'state-predicate'),
    framePending: ref('state-predicate:session-frame-pending', 'state-predicate'),
    frameAbsent: ref('state-predicate:session-frame-absent', 'state-predicate'),
    frameUnknown: ref('state-predicate:session-frame-unknown', 'state-predicate'),
  }
  const guards = {
    membership: ref('guard:captain-or-self-membership', 'guard'),
    revision: ref('guard:exact-task-revision', 'guard'),
    ready: ref('guard:task-ready', 'guard'),
    available: ref('guard:member-has-no-open-work', 'guard'),
    budget: ref('guard:budget-reservation-admissible', 'guard'),
    current: ref('guard:exact-current-attempt', 'guard'),
    runningReserved: ref('guard:attempt-running-reserved', 'guard'),
    parent: ref('guard:official-live-direct-parent-admission', 'guard'),
    claimed: ref('guard:claimed-frame-only-acknowledgement', 'guard'),
  }
  const redlines = {
    pending: ref('redline:no-pending-or-unknown-acknowledgement', 'redline'),
    duplicate: ref('redline:no-pending-or-unknown-redelivery', 'redline'),
    rollback: ref('redline:no-rollback-after-admission', 'redline'),
    storage: ref('redline:storage-is-not-team-authority', 'redline'),
  }
  const testRefs = {
    visibility: ref('test:assignment-visibility', 'test'),
    checkpoint: ref('test:team-assignment-checkpoint', 'test'),
    discipline: ref('test:scheduling-discipline', 'test'),
  }
  const docRefs = {
    core: ref('document:core-protocol', 'document'),
    testing: ref('document:testing-verification', 'document'),
    baseline: ref('document:official-baseline', 'document'),
    sources: ref('document:source-register', 'document'),
  }

  const reviewedDomain = {
    ...mechanicalDomain,
    classification: 'reviewed', ownerAuthority: team,
    maturity: maturity('composition', [testRefs.visibility.id, testRefs.checkpoint.id, testRefs.discipline.id]),
    security: security(team, 'none', { callerIdentity: 'none', dataClasses: ['team', 'secret-excluded'] }),
    tags: ['assignment-delivery', 'authority', 'kg1-d1'],
  }
  const nodes = [
    reviewedDomain,
    node(session.id, session.kind, 'Official Session event/history authority', session, [officialAnchor(facts, 'official-session-authority')], { security: security(session, 'none', { callerIdentity: 'none', dataClasses: ['session', 'secret-excluded'] }), tags: ['authority', 'official', 'session'] }),
    node(subagent.id, subagent.kind, 'Official continuable Subagent admission authority', subagent, [officialAnchor(facts, 'official-subagent-authority')], { security: security(subagent, 'none', { callerIdentity: 'none', dataClasses: ['session', 'secret-excluded'] }), tags: ['authority', 'official', 'subagent'] }),
    node(contracts.id, contracts.kind, 'Registered project contract authority', contracts, [{ file: 'docs/governance/document-registry.yaml', selector: 'stable-document-registry' }], { security: security(contracts, 'none', { callerIdentity: 'none', dataClasses: ['public'] }), tags: ['authority', 'contract'] }),
    node(task.id, task.kind, 'Team task', team, [{ file: 'src/domain/types.ts', symbol: 'TeamTask', selector: 'team-task-assignment-fields' }]),
    node(attempt.id, attempt.kind, 'Task execution attempt', team, [{ file: 'src/domain/types.ts', symbol: 'TaskAttempt', selector: 'task-attempt-assignment-fields' }]),
    node(budget.id, budget.kind, 'Team request budget', team, [seatAnchor]),
    node(frame.id, frame.kind, 'Exact assignment user-message frame', session, [claimedAnchor], { security: security(session, 'none', { dataClasses: ['session', 'team', 'secret-excluded'] }) }),
    node('state:attempt-assignment-phase', 'state', 'Attempt assignment phase', team, [{ file: 'src/domain/types.ts', symbol: 'TaskAttempt.assignmentPhase', selector: 'reserved-or-delivered' }]),
    node(budgetState.id, budgetState.kind, 'Team used request count', team, [seatAnchor]),
    node('state:session-frame-visibility', 'state', 'Session frame visibility', session, [visibilityAnchor]),
    predicate(predicates.taskCurrent.id, 'Task retains a current attempt', task, 'currentAttemptId', 'present', undefined, team, rollbackAnchor),
    predicate(predicates.taskPending.id, 'Task is pending after exact rollback', task, 'status', 'eq', 'pending', team, cancelAnchor),
    predicate(predicates.attemptRunning.id, 'Attempt phase is running', attempt, 'phase', 'eq', 'running', team, ackAnchor),
    predicate(predicates.attemptReserved.id, 'Attempt assignment is reserved', attempt, 'assignmentPhase', 'eq', 'reserved', team, claimAnchor),
    predicate(predicates.attemptDelivered.id, 'Attempt assignment is delivered', attempt, 'assignmentPhase', 'eq', 'delivered', team, ackAnchor),
    predicate(predicates.attemptStale.id, 'Rolled-back attempt is stale', attempt, 'phase', 'eq', 'stale', team, cancelAnchor),
    predicate(predicates.frameClaimed.id, 'Exact frame is claimed in user/message history', frame, 'visibility', 'eq', 'claimed', session, claimedAnchor),
    predicate(predicates.framePending.id, 'Exact frame is pending in the inbox projection', frame, 'visibility', 'eq', 'pending', session, visibilityAnchor),
    predicate(predicates.frameAbsent.id, 'Exact frame is absent from Session facts', frame, 'visibility', 'eq', 'absent', session, visibilityAnchor),
    predicate(predicates.frameUnknown.id, 'Exact frame visibility is unknown', frame, 'visibility', 'eq', 'unknown', session, visibilityAnchor),
    node(claimTx.id, claimTx.kind, 'Claim task and reserve exact attempt', team, [claimAnchor], {
      security: security(team, 'domain-transaction', { callerIdentity: 'exec-agent', guards: [guards.membership, guards.revision, guards.ready, guards.available, guards.budget] }),
      bounds: [{ name: 'task revision CAS', kind: 'revision', value: { min: 0 }, source: claimAnchor }],
    }),
    node(ackTx.id, ackTx.kind, 'Acknowledge claimed assignment', team, [ackAnchor], {
      security: security(team, 'domain-transaction', { guards: [guards.current, guards.runningReserved] }),
      bounds: [{ name: 'exact current attempt', kind: 'attempt-fence', value: 1, source: ackAnchor }],
    }),
    node(cancelTx.id, cancelTx.kind, 'Cancel exact undelivered assignment', team, [cancelAnchor, rollbackAnchor], {
      security: security(team, 'domain-transaction', { guards: [guards.membership, guards.revision, guards.current, guards.runningReserved] }),
      bounds: [
        { name: 'task revision CAS', kind: 'revision', value: { min: 0 }, source: cancelAnchor },
        { name: 'rollback diagnostic bytes', kind: 'bytes', value: { min: 1, max: 8192 }, source: cancelAnchor },
      ],
    }),
    node(scheduling.id, scheduling.kind, 'Serialized assignment scheduling and recovery owner', team, [dispatchAnchor, rollbackAnchor, settleAnchor], {
      lifecycle: { recoveryOwner: scheduling },
      security: security(subagent, 'external-effect', { authoritySource: subagent, guards: [guards.parent, guards.current, guards.runningReserved, guards.claimed], redlines: Object.values(redlines), dataClasses: ['team', 'session', 'secret-excluded'] }),
      bounds: [
        { name: 'followup admission timeout', kind: 'time-ms', value: facts.bounds.followupTimeoutMs, source: dispatchAnchor },
        { name: 'claimed-frame wait ceiling', kind: 'time-ms', value: facts.bounds.waitTimeoutMs, source: waitAnchor },
        { name: 'reserved-frame visibility timeout', kind: 'time-ms', value: facts.bounds.visibilityTimeoutMs, source: settleAnchor },
        { name: 'claimed-frame grace', kind: 'time-ms', value: facts.bounds.claimGraceMs, source: waitAnchor },
      ],
      verification: 'static', evidence: [],
    }),
    node(frameRead.id, frameRead.kind, 'Live-or-persisted exact Session frame fold', team, [visibilityAnchor, claimedAnchor], {
      security: security(session, 'read', { authoritySource: session, guards: [guards.claimed], redlines: [redlines.pending, redlines.duplicate], dataClasses: ['session', 'secret-excluded'] }),
      bounds: [
        { name: 'visibility read timeout', kind: 'time-ms', value: facts.bounds.visibilityTimeoutMs, source: visibilityAnchor },
        { name: 'claim observation grace', kind: 'time-ms', value: facts.bounds.claimGraceMs, source: waitAnchor },
      ],
      verification: 'composition', evidence: [testRefs.visibility.id],
    }),
    node(continuation.id, continuation.kind, 'Official continuable Subagent manager', subagent, [officialAnchor(facts, 'official-continuation-manager')], {
      lifecycle: { disposerOwner: continuation.id, drainOwner: continuation.id },
      security: security(subagent, 'none', { dataClasses: ['session', 'secret-excluded'] }),
      maturity: maturity('static', []), tags: ['official', 'subagent', 'lifecycle'],
    }),
    node(followup.id, followup.kind, 'Official Subagent followup admission provider', subagent, [officialAnchor(facts, 'official-followup-provider')], {
      lifecycle: { admissionOwner: continuation.id, disposerOwner: continuation.id },
      security: security(subagent, 'external-effect', { dataClasses: ['session', 'secret-excluded'] }),
      maturity: maturity('static', []), tags: ['official', 'provider', 'subagent'],
    }),
    node(sessionRead.id, sessionRead.kind, 'Official Session flush/persistence read-back provider', session, [officialAnchor(facts, 'official-session-readback'), visibilityAnchor], {
      security: security(session, 'read', { dataClasses: ['session', 'secret-excluded'] }),
      maturity: maturity('composition', [testRefs.visibility.id]), tags: ['official', 'provider', 'session'],
    }),
    node(checkpointReserved.id, checkpointReserved.kind, 'Reserved attempt durable Team checkpoint', team, [claimAnchor]),
    node(checkpointClaimed.id, checkpointClaimed.kind, 'Claimed exact Session frame checkpoint', session, [claimedAnchor]),
    node(checkpointDelivered.id, checkpointDelivered.kind, 'Delivered attempt Team checkpoint', team, [ackAnchor]),
    node(attemptFence.id, attemptFence.kind, 'Task currentAttemptId exact fence', team, [rollbackAnchor], { bounds: [{ name: 'opaque attempt identity', kind: 'attempt-fence', value: 1, source: rollbackAnchor }] }),
    node(revisionFence.id, revisionFence.kind, 'Task revision CAS fence', team, [claimAnchor], { bounds: [{ name: 'non-negative task revision', kind: 'revision', value: { min: 0 }, source: claimAnchor }] }),
    node(frameFence.id, frameFence.kind, 'Byte-exact assignment frame identity fence', session, [dispatchAnchor]),
    ...Object.entries(guards).map(([name, value]) => {
      const owner = name === 'parent' ? subagent : name === 'claimed' ? session : team
      return node(value.id, value.kind, name.replaceAll('-', ' '), owner, [name === 'parent' ? officialAnchor(facts, 'official-parent-admission') : name === 'claimed' ? claimedAnchor : claimAnchor], { security: security(owner) })
    }),
    ...Object.entries(redlines).map(([name, value]) => node(value.id, value.kind, name.replaceAll('-', ' '), name === 'storage' ? team : contracts, [name === 'storage' ? contractAnchor(facts, 'docs/04-core-protocol.md', 'team-authority-boundary', 'recovery') : contractAnchor(facts, 'docs/04-core-protocol.md', `assignment-redline-${name}`, 'scheduling')], { security: security(name === 'storage' ? team : contracts, 'none', { callerIdentity: 'none', dataClasses: ['public'] }) })),
    node(flow.id, flow.kind, 'Claim, deliver, observe, acknowledge or recover assignment', team, [dispatchAnchor, claimAnchor]),
    ...Object.entries(branchRefs).map(([name, value]) => branch(value.id, `Assignment ${name.replaceAll('-', ' ')}`, flow, team, name === 'claim-reserved' ? claimAnchor : name === 'admission-rejected' ? rollbackAnchor : name === 'claimed' ? ackAnchor : visibilityAnchor)),
    node(testRefs.visibility.id, testRefs.visibility.kind, 'Assignment visibility composition test', contracts, [{ file: 'tests/assignment-visibility.spec.ts', selector: `test-${facts.tests.find(item => item.file === 'tests/assignment-visibility.spec.ts').semanticDigest.slice(0, 16)}` }], { verification: 'composition', security: security(contracts, 'none', { callerIdentity: 'none', dataClasses: ['public'] }) }),
    node(testRefs.checkpoint.id, testRefs.checkpoint.kind, 'Assignment checkpoint domain test', contracts, [{ file: 'tests/team-assignment-checkpoint.spec.ts', selector: `test-${facts.tests.find(item => item.file === 'tests/team-assignment-checkpoint.spec.ts').semanticDigest.slice(0, 16)}` }], { verification: 'unit', security: security(contracts, 'none', { callerIdentity: 'none', dataClasses: ['public'] }) }),
    node(testRefs.discipline.id, testRefs.discipline.kind, 'Scheduling rollback composition test', contracts, [{ file: 'tests/scheduling-discipline.spec.ts', selector: `test-${facts.tests.find(item => item.file === 'tests/scheduling-discipline.spec.ts').semanticDigest.slice(0, 16)}` }], { verification: 'composition', security: security(contracts, 'none', { callerIdentity: 'none', dataClasses: ['public'] }) }),
    node(docRefs.core.id, docRefs.core.kind, 'Registered core protocol', contracts, [contractAnchor(facts, 'docs/04-core-protocol.md', 'assignment-delivery-contract', 'scheduling')], { security: security(contracts, 'none', { callerIdentity: 'none', dataClasses: ['public'] }) }),
    node(docRefs.testing.id, docRefs.testing.kind, 'Registered verification contract', contracts, [contractAnchor(facts, 'docs/08-testing-verification.md', 'assignment-verification-contract', 'verification')], { security: security(contracts, 'none', { callerIdentity: 'none', dataClasses: ['public'] }) }),
    node(docRefs.baseline.id, docRefs.baseline.kind, 'Registered official release baseline', contracts, [officialAnchor(facts, 'official-release-baseline')], { security: security(contracts, 'none', { callerIdentity: 'none', dataClasses: ['public'] }) }),
    node(docRefs.sources.id, docRefs.sources.kind, 'Official source register', contracts, [{ file: 'docs/09-sources.md', selector: `official-source-register-${facts.official.commit.slice(0, 12)}` }], { security: security(contracts, 'none', { callerIdentity: 'none', dataClasses: ['public'] }) }),
  ]

  const edges = []
  const add = (...items) => edges.push(...items)
  const ownerAnchor = { file: 'docs/04-core-protocol.md', selector: 'assignment-authority-closure' }
  for (const item of nodes) {
    if (['authority', 'official-authority', 'domain'].includes(item.kind)) continue
    add(edge(`edge:owner/${item.id.replace(':', '/')}`, 'owns', item.ownerAuthority, ref(item.id, item.kind), ownerAnchor))
  }
  add(
    edge('edge:task/team-authority', 'persists-in', task, team, claimAnchor),
    edge('edge:attempt/team-authority', 'persists-in', attempt, team, claimAnchor),
    edge('edge:budget/team-authority', 'persists-in', budget, team, seatAnchor),
    edge('edge:frame/session-authority', 'persists-in', frame, session, claimedAnchor),
    edge('edge:attempt-state/team-authority', 'persists-in', ref('state:attempt-assignment-phase', 'state'), team, ackAnchor),
    edge('edge:budget-state/team-authority', 'persists-in', budgetState, team, seatAnchor),
    edge('edge:frame-state/session-authority', 'persists-in', ref('state:session-frame-visibility', 'state'), session, visibilityAnchor),
    edge('edge:claim/mutates-task', 'mutates', claimTx, task, claimAnchor),
    edge('edge:claim/mutates-attempt', 'mutates', claimTx, attempt, claimAnchor),
    edge('edge:claim/mutates-budget', 'mutates', claimTx, budget, seatAnchor),
    edge('edge:claim/checkpoint-reserved', 'checkpoints', claimTx, checkpointReserved, claimAnchor),
    edge('edge:claim/transitions-assignment', 'transitions', claimTx, ref('state:attempt-assignment-phase', 'state'), claimAnchor),
    edge('edge:claim/transitions-budget-used-requests', 'transitions', claimTx, budgetState, seatAnchor),
    edge('edge:ack/mutates-attempt', 'mutates', ackTx, attempt, ackAnchor),
    edge('edge:ack/checkpoint-delivered', 'checkpoints', ackTx, checkpointDelivered, ackAnchor),
    edge('edge:ack/transitions-assignment', 'transitions', ackTx, ref('state:attempt-assignment-phase', 'state'), ackAnchor),
    edge('edge:cancel/mutates-task', 'mutates', cancelTx, task, cancelAnchor),
    edge('edge:cancel/mutates-attempt', 'mutates', cancelTx, attempt, cancelAnchor),
    edge('edge:scheduling/calls-cancel', 'calls', scheduling, cancelTx, rollbackAnchor),
    edge('edge:scheduling/calls-ack', 'calls', scheduling, ackTx, ackAnchor, {
      crash: crash(flow, branchRefs.claimed, {
        phase: 'transaction', durability: 'atomic-commit', recoveryMode: 'state-changing',
        expectedBefore: [predicates.taskCurrent, predicates.attemptRunning, predicates.attemptReserved, predicates.frameClaimed],
        committedAfter: [predicates.attemptDelivered], checkpoint: checkpointDelivered,
        fences: [attemptFence, frameFence], recoveryTransactions: [ackTx],
        failureCode: 'ASSIGNMENT_ACK_RESULT_UNKNOWN', authoritativePostState: 'unknown', retryRule: 'exact-readback-first',
        idempotency: { domainTag: 'dsh-agent-swarm/assignment-ack/v1', components: [{ source: ackTx, kind: 'transaction-input', selector: 'attemptId' }] },
      }),
    }),
    edge('edge:scheduling/calls-followup-rejected', 'calls', scheduling, followup, dispatchAnchor, {
      crash: crash(flow, branchRefs['admission-rejected'], {
        phase: 'external-effect', durability: 'none', recoveryMode: 'state-changing',
        expectedBefore: [predicates.taskCurrent, predicates.attemptRunning, predicates.attemptReserved],
        committedAfter: [predicates.taskPending, predicates.attemptStale], checkpoint: checkpointReserved,
        fences: [revisionFence, attemptFence, frameFence], recoveryTransactions: [cancelTx],
        failureCode: 'SUBAGENT_MESSAGE_NOT_ADMITTED', authoritativePostState: 'unchanged', retryRule: 'same-fenced-operation',
        idempotency: { domainTag: 'dsh-agent-swarm/assignment-rollback/v1', components: [{ source: cancelTx, kind: 'transaction-input', selector: 'taskId' }, { source: cancelTx, kind: 'transaction-input', selector: 'attemptId' }] },
      }),
    }),
    edge('edge:scheduling/calls-followup-unknown', 'calls', scheduling, followup, dispatchAnchor, {
      crash: crash(flow, branchRefs['admission-unknown'], {
        phase: 'external-effect', durability: 'external-unknown', recoveryMode: 'observe-block',
        expectedBefore: [predicates.taskCurrent, predicates.attemptRunning, predicates.attemptReserved], committedAfter: [],
        checkpoint: checkpointClaimed, fences: [attemptFence, frameFence], recoveryTransactions: [],
        failureCode: 'SUBAGENT_ADMISSION_POST_STATE_UNKNOWN', authoritativePostState: 'unknown', retryRule: 'exact-readback-first',
      }),
    }),
    edge('edge:scheduling/calls-followup-redelivery', 'calls', scheduling, followup, settleAnchor, {
      crash: crash(flow, branchRefs.absent, {
        phase: 'external-effect', durability: 'external-unknown', recoveryMode: 'observe-block',
        expectedBefore: [predicates.taskCurrent, predicates.attemptRunning, predicates.attemptReserved, predicates.frameAbsent], committedAfter: [], checkpoint: checkpointClaimed,
        fences: [attemptFence, frameFence], recoveryTransactions: [], failureCode: 'SUBAGENT_REDELIVERY_POST_STATE_UNKNOWN',
        authoritativePostState: 'unknown', retryRule: 'exact-readback-first',
      }),
    }),
    edge('edge:scheduling/calls-frame-visibility', 'calls', scheduling, frameRead, visibilityAnchor),
    edge('edge:frame-visibility/calls-session-readback', 'calls', frameRead, sessionRead, visibilityAnchor),
    edge('edge:scheduling/read-task-current', 'reads', scheduling, predicates.taskCurrent, rollbackAnchor),
    edge('edge:scheduling/read-attempt-running', 'reads', scheduling, predicates.attemptRunning, rollbackAnchor),
    edge('edge:scheduling/read-attempt-reserved', 'reads', scheduling, predicates.attemptReserved, settleAnchor),
    edge('edge:scheduling/read-attempt-delivered', 'reads', scheduling, predicates.attemptDelivered, ackAnchor),
    edge('edge:scheduling/read-task-pending', 'reads', scheduling, predicates.taskPending, rollbackAnchor),
    edge('edge:scheduling/read-attempt-stale', 'reads', scheduling, predicates.attemptStale, rollbackAnchor),
    edge('edge:scheduling/read-frame-claimed', 'reads', scheduling, predicates.frameClaimed, visibilityAnchor),
    edge('edge:scheduling/read-frame-pending', 'reads', scheduling, predicates.framePending, visibilityAnchor),
    edge('edge:scheduling/read-frame-absent', 'reads', scheduling, predicates.frameAbsent, visibilityAnchor),
    edge('edge:scheduling/read-frame-unknown', 'reads', scheduling, predicates.frameUnknown, visibilityAnchor),
    edge('edge:scheduling/read-reserved-checkpoint', 'reads', scheduling, checkpointReserved, settleAnchor),
    edge('edge:scheduling/read-claimed-checkpoint', 'reads', scheduling, checkpointClaimed, visibilityAnchor),
    edge('edge:scheduling/read-delivered-checkpoint', 'reads', scheduling, checkpointDelivered, ackAnchor),
    edge('edge:scheduling/read-attempt-fence', 'reads', scheduling, attemptFence, rollbackAnchor),
    edge('edge:scheduling/read-revision-fence', 'reads', scheduling, revisionFence, rollbackAnchor),
    edge('edge:scheduling/read-frame-fence', 'reads', scheduling, frameFence, visibilityAnchor),
    edge('edge:frame-visibility/read-frame', 'reads', frameRead, frame, visibilityAnchor),
    edge('edge:frame-visibility/read-claimed', 'reads', frameRead, predicates.frameClaimed, visibilityAnchor),
    edge('edge:frame-visibility/read-pending', 'reads', frameRead, predicates.framePending, visibilityAnchor),
    edge('edge:frame-visibility/read-absent', 'reads', frameRead, predicates.frameAbsent, visibilityAnchor),
    edge('edge:frame-visibility/read-unknown', 'reads', frameRead, predicates.frameUnknown, visibilityAnchor),
    edge('edge:frame-visibility/read-claimed-checkpoint', 'reads', frameRead, checkpointClaimed, visibilityAnchor),
    edge('edge:frame-visibility/read-frame-fence', 'reads', frameRead, frameFence, visibilityAnchor),
    edge('edge:session-readback/read-frame', 'reads', sessionRead, frame, visibilityAnchor),
  )
  for (const [name, guard] of Object.entries(guards)) {
    const target = ['membership', 'revision', 'ready', 'available', 'budget'].includes(name) ? claimTx
      : name === 'claimed' ? scheduling : name === 'parent' ? scheduling : cancelTx
    const edgeName = name.replace(/[A-Z]/gu, value => `-${value.toLowerCase()}`)
    add(edge(`edge:guard/${edgeName}`, 'guards', guard, target, name === 'parent' ? officialAnchor(facts, 'official-admission-guard') : name === 'claimed' ? claimedAnchor : claimAnchor))
  }
  for (const branchRef of Object.values(branchRefs)) add(edge(`edge:flow/${branchRef.id.split('/').at(-1)}`, 'contains', flow, branchRef, dispatchAnchor))
  add(
    edge('edge:flow/trigger-claim', 'triggers', claimTx, flow, claimAnchor),
    edge('edge:recovery/admission-rejected', 'recovers', scheduling, branchRefs['admission-rejected'], rollbackAnchor),
    edge('edge:recovery/admission-unknown', 'recovers', scheduling, branchRefs['admission-unknown'], visibilityAnchor),
    edge('edge:recovery/claimed', 'recovers', scheduling, branchRefs.claimed, ackAnchor),
    edge('edge:recovery/absent', 'recovers', scheduling, branchRefs.absent, visibilityAnchor),
    edge('edge:recovery/pending', 'recovers', scheduling, branchRefs.pending, visibilityAnchor, {
      crash: crash(flow, branchRefs.pending, {
        phase: 'recovery', durability: 'durable-readback', recoveryMode: 'observe-block',
        expectedBefore: [predicates.taskCurrent, predicates.attemptRunning, predicates.attemptReserved, predicates.framePending],
        committedAfter: [], fences: [attemptFence, frameFence], recoveryTransactions: [],
        failureCode: 'ASSIGNMENT_FRAME_PENDING', authoritativePostState: 'unchanged', retryRule: 'exact-readback-first',
      }),
    }),
    edge('edge:recovery/unknown', 'recovers', scheduling, branchRefs.unknown, visibilityAnchor, {
      crash: crash(flow, branchRefs.unknown, {
        phase: 'recovery', durability: 'external-unknown', recoveryMode: 'observe-block',
        expectedBefore: [predicates.taskCurrent, predicates.attemptRunning, predicates.attemptReserved, predicates.frameUnknown],
        committedAfter: [], fences: [attemptFence, frameFence], recoveryTransactions: [],
        failureCode: 'ASSIGNMENT_FRAME_VISIBILITY_UNKNOWN', authoritativePostState: 'unknown', retryRule: 'exact-readback-first',
      }),
    }),
    edge('edge:followup/continuation-service', 'provides', followup, continuation, officialAnchor(facts, 'official-followup-service')),
    edge('edge:flow/verified-visibility', 'verified-by', flow, testRefs.visibility, dispatchAnchor),
    edge('edge:ack/verified-checkpoint', 'verified-by', ackTx, testRefs.checkpoint, ackAnchor),
    edge('edge:rollback/verified-discipline', 'verified-by', cancelTx, testRefs.discipline, rollbackAnchor),
    edge('edge:flow/documented-core', 'documented-by', flow, docRefs.core, contractAnchor(facts, 'docs/04-core-protocol.md', 'assignment-contract', 'scheduling')),
    edge('edge:flow/documented-testing', 'documented-by', flow, docRefs.testing, contractAnchor(facts, 'docs/08-testing-verification.md', 'assignment-tests', 'verification')),
    edge('edge:subagent/documented-baseline', 'documented-by', subagent, docRefs.baseline, officialAnchor(facts, 'official-baseline-trace')),
    edge('edge:session/documented-sources', 'documented-by', session, docRefs.sources, { file: 'docs/09-sources.md', selector: 'official-source-trace' }),
  )

  nodes.sort((left, right) => compareText(left.id, right.id))
  edges.sort((left, right) => compareText(left.id, right.id))
  return { nodes, edges }
}

function duplicates(items) {
  const seen = new Set()
  return items.filter(item => seen.has(item.id) || !seen.add(item.id)).map(item => item.id)
}

export function mergeAssignmentDeliverySlice(manifest, slice) {
  const ids = new Set(slice.nodes.map(item => item.id))
  const edgeIds = new Set(slice.edges.map(item => item.id))
  const retiredNodeIds = new Set(['flow-branch:assignment-delivery/pending-or-unknown'])
  const retiredEdgeIds = new Set(['edge:guard/runningReserved', 'edge:scheduling/calls-claim', 'edge:flow/pending-or-unknown', 'edge:recovery/pending-or-unknown', 'edge:owner/flow-branch/assignment-delivery/pending-or-unknown'])
  const merged = structuredClone(manifest)
  merged.nodes = [...merged.nodes.filter(item => !ids.has(item.id) && !retiredNodeIds.has(item.id)), ...structuredClone(slice.nodes)].sort((left, right) => compareText(left.id, right.id))
  merged.edges = [...merged.edges.filter(item => !edgeIds.has(item.id) && !retiredEdgeIds.has(item.id)), ...structuredClone(slice.edges)].sort((left, right) => compareText(left.id, right.id))
  if (duplicates(merged.nodes).length || duplicates(merged.edges).length) fail('KG_SEMANTIC_ID_COLLISION', 'semantic slice collides with another canonical identity')
  return merged
}
