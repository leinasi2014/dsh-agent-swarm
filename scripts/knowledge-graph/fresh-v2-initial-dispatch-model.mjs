import { fail } from './diagnostics.mjs'
import { validateFreshV2InitialDispatchFacts } from './extractors/fresh-v2-initial-dispatch.mjs'

const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0
const sourceAuthority = { id: 'authority:source-tree', kind: 'authority' }
const team = { id: 'domain:agent-swarm', kind: 'domain' }
const agentLoop = { id: 'official-authority:agent-loop', kind: 'official-authority' }
const session = { id: 'official-authority:session', kind: 'official-authority' }
const subagent = { id: 'official-authority:subagent', kind: 'official-authority' }
const llm = { id: 'official-authority:llm-runtime', kind: 'official-authority' }
const contracts = { id: 'authority:project-contracts', kind: 'authority' }

const ref = (id, kind) => ({ id, kind })

function maturity(verification = 'composition', evidence = []) {
  return {
    implementation: { state: 'implemented', evidence: [] },
    verification: { state: verification, evidence },
    acceptance: { state: 'candidate' },
    availability: {
      state: 'config-gated',
      conditions: ['experimentalFreshV2=true with official DSH services, candidate artifact contract and official host contract'],
      blockers: [],
    },
  }
}

function absentMaturity(blocker) {
  return {
    implementation: { state: 'absent', evidence: [] },
    verification: { state: 'none', evidence: [] },
    acceptance: { state: 'not-candidate' },
    availability: { state: 'unavailable', conditions: [], blockers: [blocker] },
  }
}

function security(owner, mutation = 'none', options = {}) {
  return {
    authoritySource: options.authoritySource ?? owner,
    callerIdentity: options.callerIdentity ?? 'internal-provider',
    mutation,
    dataClasses: options.dataClasses ?? ['team', 'session', 'secret-excluded'],
    guards: options.guards ?? [],
    redlines: options.redlines ?? [],
  }
}

function anchor(facts, file, selector) {
  const item = facts.files.find(candidate => candidate.file === file)
  if (item === undefined) fail('KG_FRESH_V2_SOURCE', `fresh-v2 anchor source is missing: ${file}`)
  return { file, selector: `${selector}-${item.digest.slice(0, 16)}` }
}

function node(facts, id, kind, title, owner, file, selector, options = {}) {
  return {
    id,
    kind,
    classification: 'reviewed',
    factAuthority: sourceAuthority,
    title,
    anchors: [anchor(facts, file, selector)],
    ownerAuthority: owner,
    config: { gates: [], defaultState: options.defaultState ?? 'enabled', blockerCodes: [] },
    inject: { required: [], optional: [], provides: [] },
    lifecycle: options.lifecycle ?? {},
    maturity: options.maturity ?? maturity(options.verification, options.evidence),
    security: options.security ?? security(owner, options.mutation),
    bounds: options.bounds ?? [],
    ...(options.contract === undefined ? {} : { contract: options.contract }),
    tags: ['fresh-v2-initial-dispatch', 'kg1-d2'],
  }
}

function edge(facts, id, type, from, to, file, selector) {
  return { id, type, classification: 'reviewed', from, to, anchors: [anchor(facts, file, selector)] }
}

function predicate(facts, id, title, selector, value, file) {
  const entity = ref('entity:fresh-v2-task-attempt', 'entity')
  return node(facts, id, 'state-predicate', title, team, file, id.split('/').at(-1), {
    contract: {
      nodeKind: 'state-predicate',
      predicate: { entity, field: { schema: entity, selector }, operator: 'eq', value },
    },
  })
}

export function buildFreshV2InitialDispatchSlice(facts) {
  validateFreshV2InitialDispatchFacts(facts)
  const runtimeFile = 'src/runtime/fresh-v2-initial-runtime.ts'
  const domainFile = 'src/domain/team-domain-v2-start.ts'
  const foldFile = 'src/runtime/fresh-v2-session-fold.ts'
  const capabilityFile = 'src/runtime/fresh-v2-witness-capability.ts'
  const flow = ref('flow:fresh-v2-initial-dispatch', 'flow')
  const service = ref('service:fresh-v2-initial-runtime', 'service')
  const attempt = ref('entity:fresh-v2-task-attempt', 'entity')
  const dispatch = ref('entity:fresh-v2-model-dispatch-epoch', 'entity')
  const frame = ref('entity:fresh-v2-initial-assignment-frame', 'entity')
  const assistant = ref('event:fresh-v2-assistant-message-evidence', 'event')
  const startProvider = ref('provider:official-subagent-start-continuable', 'provider')
  const tx = {
    reserve: ref('transaction:fresh-v2-create-reserve-initial', 'transaction'),
    settle: ref('transaction:fresh-v2-settle-initial-assignment', 'transaction'),
    fail: ref('transaction:fresh-v2-fail-initial', 'transaction'),
    enter: ref('transaction:fresh-v2-enter-initial-dispatch', 'transaction'),
    evidence: ref('transaction:fresh-v2-settle-assistant-evidence', 'transaction'),
  }
  const checkpoints = {
    frame: ref('checkpoint:fresh-v2-assignment-frame-durable', 'checkpoint'),
    pending: ref('checkpoint:fresh-v2-dispatch-pending-readback', 'checkpoint'),
    entered: ref('checkpoint:fresh-v2-dispatch-entered-readback', 'checkpoint'),
    evidence: ref('checkpoint:fresh-v2-assistant-evidence-durable', 'checkpoint'),
  }
  const fences = {
    attempt: ref('fence:fresh-v2-current-attempt-tuple', 'fence'),
    prompt: ref('fence:fresh-v2-initial-prompt-digest', 'fence'),
    dispatch: ref('fence:fresh-v2-dispatch-identity', 'fence'),
  }
  const guards = {
    activation: ref('guard:fresh-v2-experimental-activation', 'guard'),
    official: ref('guard:fresh-v2-official-agent-loop-request', 'guard'),
    capability: ref('guard:fresh-v2-fixed-profile-witness-capability', 'guard'),
  }
  const capability = ref('capability:fresh-v2-model-dispatch-witness', 'public-capability')
  const predicates = {
    start: ref('state-predicate:fresh-v2-initial/start-reserved', 'state-predicate'),
    pending: ref('state-predicate:fresh-v2-initial/dispatch-pending', 'state-predicate'),
    entered: ref('state-predicate:fresh-v2-initial/dispatch-entered', 'state-predicate'),
    running: ref('state-predicate:fresh-v2-initial/running-evidenced', 'state-predicate'),
    failed: ref('state-predicate:fresh-v2-initial/failed-requeued', 'state-predicate'),
  }
  const states = {
    start: ref('state:fresh-v2-initial/start-reserved', 'state'),
    pending: ref('state:fresh-v2-initial/dispatch-pending', 'state'),
    entered: ref('state:fresh-v2-initial/dispatch-entered', 'state'),
    running: ref('state:fresh-v2-initial/running-evidenced', 'state'),
    failed: ref('state:fresh-v2-initial/failed-requeued', 'state'),
  }
  const tests = {
    runtime: ref('test:fresh-v2-initial-runtime', 'test'),
    fold: ref('test:fresh-v2-session-fold', 'test'),
    foundation: ref('test:team-v2-foundation', 'test'),
    profile: ref('test:a1b-official-profile-smoke', 'test'),
  }
  const document = ref('document:fresh-v2-runtime-blueprint', 'document')
  const implementedBranches = [
    'provider-start-rejected',
    'pre-model-barrier-rejected',
    'dispatch-pending-held',
    'downstream-failed-after-entered',
    'assistant-evidence-undurable',
  ]
  const absentBranches = facts.absentRecoveryBranches

  const nodes = [
    node(facts, agentLoop.id, agentLoop.kind, 'Official DSH Agent Loop execution authority', agentLoop, 'src/index.ts', 'official-agent-loop-authority', { verification: 'real-profile', evidence: [tests.profile.id], security: security(agentLoop) }),
    node(facts, llm.id, llm.kind, 'Official DSH LLM registry and stream waterfall authority', llm, capabilityFile, 'official-llm-authority', { verification: 'composition', evidence: [tests.runtime.id], security: security(llm) }),
    node(facts, service.id, service.kind, 'Fresh-v2 initial dispatch runtime', team, runtimeFile, 'fresh-v2-runtime', { verification: 'real-profile', evidence: [tests.runtime.id, tests.profile.id], mutation: 'external-effect', security: security(agentLoop, 'external-effect', { guards: [guards.official] }) }),
    node(facts, flow.id, flow.kind, 'Fresh-v2 first member assignment and model dispatch', team, runtimeFile, 'fresh-v2-initial-flow', { verification: 'real-profile', evidence: [tests.runtime.id, tests.fold.id, tests.foundation.id, tests.profile.id] }),
    node(facts, attempt.id, attempt.kind, 'Fresh-v2 task Attempt', team, 'src/domain/team-state-v2.ts', 'fresh-v2-attempt'),
    node(facts, dispatch.id, dispatch.kind, 'Fresh-v2 model dispatch epoch', team, 'src/domain/team-state-v2.ts', 'fresh-v2-dispatch-epoch'),
    node(facts, frame.id, frame.kind, 'Exact initial assignment Session frame', session, foldFile, 'fresh-v2-initial-frame', { security: security(session) }),
    node(facts, assistant.id, assistant.kind, 'Durable exact assistant message evidence', session, foldFile, 'fresh-v2-assistant-evidence', { security: security(session) }),
    node(facts, startProvider.id, startProvider.kind, 'Official continuable Subagent start provider', subagent, runtimeFile, 'official-start-continuable', { security: security(subagent, 'external-effect') }),
    node(facts, tx.reserve.id, tx.reserve.kind, 'Create task and reserve initial Attempt atomically', team, domainFile, 'create-reserve-initial', { security: security(team, 'domain-transaction', { guards: [guards.activation] }) }),
    node(facts, tx.settle.id, tx.settle.kind, 'Settle durable initial assignment frame', team, domainFile, 'settle-initial-assignment', { security: security(team, 'domain-transaction', { guards: [guards.official] }) }),
    node(facts, tx.fail.id, tx.fail.kind, 'Fail rejected initial member start and requeue task', team, domainFile, 'fail-initial-assignment', { security: security(team, 'domain-transaction', { guards: [guards.activation] }) }),
    node(facts, tx.enter.id, tx.enter.kind, 'Enter exact provider dispatch epoch', team, domainFile, 'enter-initial-dispatch', { security: security(agentLoop, 'domain-transaction', { guards: [guards.official] }) }),
    node(facts, tx.evidence.id, tx.evidence.kind, 'Admit durable assistant evidence and mark Attempt running', team, domainFile, 'settle-assistant-evidence', { security: security(session, 'domain-transaction', { guards: [guards.official] }) }),
    node(facts, checkpoints.frame.id, checkpoints.frame.kind, 'Initial assignment Session frame is durable', session, runtimeFile, 'assignment-frame-durable'),
    node(facts, checkpoints.pending.id, checkpoints.pending.kind, 'Dispatch-pending Team read-back succeeded', team, runtimeFile, 'dispatch-pending-readback'),
    node(facts, checkpoints.entered.id, checkpoints.entered.kind, 'Dispatch-entered Team read-back succeeded', team, runtimeFile, 'dispatch-entered-readback'),
    node(facts, checkpoints.evidence.id, checkpoints.evidence.kind, 'Assistant evidence Session flush succeeded', session, runtimeFile, 'assistant-evidence-durable'),
    node(facts, fences.attempt.id, fences.attempt.kind, 'Exact task/Attempt/member causal tuple', team, domainFile, 'current-attempt-tuple'),
    node(facts, fences.prompt.id, fences.prompt.kind, 'Exact initial prompt digest', session, foldFile, 'initial-prompt-digest'),
    node(facts, fences.dispatch.id, fences.dispatch.kind, 'Exact dispatch id/effect/turn/step identity', team, domainFile, 'dispatch-identity'),
    node(facts, guards.activation.id, guards.activation.kind, 'Fresh-v2 is explicit and isolated from v1 activation', team, 'src/index.ts', 'experimental-activation'),
    node(facts, guards.official.id, guards.official.kind, 'Exact official Agent Loop AbortSignal permit and Session coordinates', agentLoop, runtimeFile, 'official-loop-permit', { security: security(agentLoop) }),
    node(facts, guards.capability.id, guards.capability.kind, 'Fixed-Profile host, artifact, Provider and listener-order witness', llm, capabilityFile, 'fixed-profile-capability', { security: security(llm) }),
    node(facts, capability.id, capability.kind, 'Network-free per-Provider model dispatch witness capability', llm, capabilityFile, 'model-dispatch-capability', { verification: 'composition', evidence: [tests.runtime.id], security: security(llm) }),
    predicate(facts, predicates.start.id, 'Member starting with reserved undelivered Attempt and no dispatch epoch', 'compound.startReserved', 'true', domainFile),
    predicate(facts, predicates.pending.id, 'Member active with delivered reserved Attempt and dispatch-pending', 'compound.dispatchPending', 'true', domainFile),
    predicate(facts, predicates.entered.id, 'Exact dispatch epoch entered the provider boundary', 'compound.dispatchEntered', 'true', domainFile),
    predicate(facts, predicates.running.id, 'Attempt running only after exact durable assistant evidence', 'compound.runningEvidenced', 'true', domainFile),
    predicate(facts, predicates.failed.id, 'Rejected start failed member, cancelled Attempt and requeued task', 'compound.failedRequeued', 'true', domainFile),
    ...Object.entries(states).map(([name, value]) => node(facts, value.id, value.kind, `Fresh-v2 initial ${name} state`, team, domainFile, `state-${name}`)),
    node(facts, tests.runtime.id, tests.runtime.kind, 'Fresh-v2 official Agent Loop composition tests', contracts, 'tests/fresh-v2-initial-runtime.spec.ts', 'fresh-v2-runtime-tests', { verification: 'unit', evidence: [], security: security(contracts) }),
    node(facts, tests.fold.id, tests.fold.kind, 'Fresh-v2 Session fold tests', contracts, 'tests/fresh-v2-session-fold.spec.ts', 'fresh-v2-fold-tests', { verification: 'unit', evidence: [], security: security(contracts) }),
    node(facts, tests.foundation.id, tests.foundation.kind, 'Fresh-v2 domain state invariant tests', contracts, 'tests/team-v2-foundation.spec.ts', 'fresh-v2-foundation-tests', { verification: 'unit', evidence: [], security: security(contracts) }),
    node(facts, tests.profile.id, tests.profile.kind, 'Isolated official DSH Profile install/restart smoke', contracts, 'scripts/a1b/run-profile-smoke.mjs', 'a1b-profile-smoke', { verification: 'real-profile', evidence: [], security: security(contracts) }),
    node(facts, document.id, document.kind, 'Fresh-v2 runtime architecture blueprint', contracts, 'docs/development/2026-08-24-team-runtime-architecture-blueprint-v1.md', 'fresh-v2-blueprint', { verification: 'static', evidence: [], security: security(contracts) }),
    ...implementedBranches.map(name => node(facts, `flow-branch:fresh-v2-initial-dispatch/${name}`, 'flow-branch', name.replaceAll('-', ' '), team, runtimeFile, `branch-${name}`, { contract: { nodeKind: 'flow-branch', flow } })),
    ...absentBranches.map(name => node(facts, `flow-branch:fresh-v2-initial-dispatch/${name}`, 'flow-branch', name.replaceAll('-', ' '), team, runtimeFile, `absent-${name}`, { maturity: absentMaturity(`A2 recovery slice: ${name}`), contract: { nodeKind: 'flow-branch', flow }, defaultState: 'disabled' })),
  ]

  const edges = []
  const add = (...items) => edges.push(...items)
  for (const owned of [service, flow, attempt, dispatch, ...Object.values(tx), checkpoints.pending, checkpoints.entered, fences.attempt, fences.dispatch, guards.activation, ...Object.values(predicates), ...Object.values(states)]) {
    add(edge(facts, `edge:fresh-v2-owner/${owned.id.replace(':', '/')}`, 'owns', team, owned, runtimeFile, `owner-${owned.id}`))
  }
  add(
    edge(facts, 'edge:fresh-v2-owner/session-frame-checkpoint', 'owns', session, checkpoints.frame, runtimeFile, 'owner-frame-checkpoint'),
    edge(facts, 'edge:fresh-v2-owner/session-evidence-checkpoint', 'owns', session, checkpoints.evidence, runtimeFile, 'owner-evidence-checkpoint'),
    edge(facts, 'edge:fresh-v2-owner/session-prompt-fence', 'owns', session, fences.prompt, runtimeFile, 'owner-prompt-fence'),
    edge(facts, 'edge:fresh-v2-owner/official-start-provider', 'owns', subagent, startProvider, runtimeFile, 'owner-start-provider'),
    edge(facts, 'edge:fresh-v2-owner/official-loop-guard', 'owns', agentLoop, guards.official, runtimeFile, 'owner-official-loop-guard'),
    edge(facts, 'edge:fresh-v2-owner/official-llm-capability', 'owns', llm, capability, capabilityFile, 'owner-llm-capability'),
    edge(facts, 'edge:fresh-v2-owner/official-llm-capability-guard', 'owns', llm, guards.capability, capabilityFile, 'owner-llm-capability-guard'),
  )
  for (const name of [...implementedBranches, ...absentBranches]) {
    const branch = ref(`flow-branch:fresh-v2-initial-dispatch/${name}`, 'flow-branch')
    add(
      edge(facts, `edge:fresh-v2-flow/${name}`, 'contains', flow, branch, runtimeFile, `flow-${name}`),
      edge(facts, `edge:fresh-v2-owner/${branch.id.replace(':', '/')}`, 'owns', team, branch, runtimeFile, `owner-${name}`),
    )
  }
  add(
    edge(facts, 'edge:fresh-v2/activation-guards-flow', 'guards', guards.activation, flow, 'src/index.ts', 'activation-guards'),
    edge(facts, 'edge:fresh-v2/create-task-calls-reserve', 'calls', service, tx.reserve, runtimeFile, 'create-calls-reserve'),
    edge(facts, 'edge:fresh-v2/reserve-transitions-start', 'transitions', tx.reserve, states.start, domainFile, 'reserve-start'),
    edge(facts, 'edge:fresh-v2/reserve-mutates-attempt', 'mutates', tx.reserve, attempt, domainFile, 'reserve-mutates-attempt'),
    edge(facts, 'edge:fresh-v2/service-calls-subagent', 'calls', service, startProvider, runtimeFile, 'start-continuable'),
    edge(facts, 'edge:fresh-v2/rejected-calls-fail', 'calls', service, tx.fail, runtimeFile, 'rejected-fail'),
    edge(facts, 'edge:fresh-v2/fail-transitions-requeue', 'transitions', tx.fail, states.failed, domainFile, 'fail-requeue'),
    edge(facts, 'edge:fresh-v2/fail-mutates-attempt', 'mutates', tx.fail, attempt, domainFile, 'fail-mutates-attempt'),
    edge(facts, 'edge:fresh-v2/agent-loop-triggers-settle', 'triggers', agentLoop, tx.settle, runtimeFile, 'agent-request-settle'),
    edge(facts, 'edge:fresh-v2/settle-checkpoints-frame', 'checkpoints', tx.settle, checkpoints.frame, runtimeFile, 'settle-frame'),
    edge(facts, 'edge:fresh-v2/settle-checkpoints-pending', 'checkpoints', tx.settle, checkpoints.pending, runtimeFile, 'settle-pending'),
    edge(facts, 'edge:fresh-v2/settle-transitions-pending', 'transitions', tx.settle, states.pending, domainFile, 'settle-pending-state'),
    edge(facts, 'edge:fresh-v2/settle-mutates-dispatch', 'mutates', tx.settle, dispatch, domainFile, 'settle-mutates-dispatch'),
    edge(facts, 'edge:fresh-v2/official-permit-guards-enter', 'guards', guards.official, tx.enter, runtimeFile, 'official-permit-enter'),
    edge(facts, 'edge:fresh-v2/capability-guards-flow', 'guards', guards.capability, flow, capabilityFile, 'capability-guards-flow'),
    edge(facts, 'edge:fresh-v2/capability-guards-enter', 'guards', guards.capability, tx.enter, capabilityFile, 'capability-guards-enter'),
    edge(facts, 'edge:fresh-v2/service-exposes-capability', 'exposes', service, capability, capabilityFile, 'service-exposes-capability'),
    edge(facts, 'edge:fresh-v2/capability-verified-runtime', 'verified-by', capability, tests.runtime, capabilityFile, 'capability-verified-runtime'),
    edge(facts, 'edge:fresh-v2/agent-loop-calls-enter', 'calls', agentLoop, tx.enter, runtimeFile, 'agent-loop-enter'),
    edge(facts, 'edge:fresh-v2/enter-checkpoints-entered', 'checkpoints', tx.enter, checkpoints.entered, runtimeFile, 'enter-readback'),
    edge(facts, 'edge:fresh-v2/enter-transitions-entered', 'transitions', tx.enter, states.entered, domainFile, 'enter-state'),
    edge(facts, 'edge:fresh-v2/enter-mutates-dispatch', 'mutates', tx.enter, dispatch, domainFile, 'enter-mutates-dispatch'),
    edge(facts, 'edge:fresh-v2/session-emits-assistant', 'emits', session, assistant, runtimeFile, 'session-assistant'),
    edge(facts, 'edge:fresh-v2/service-listens-assistant', 'listens', service, assistant, runtimeFile, 'listen-assistant'),
    edge(facts, 'edge:fresh-v2/assistant-checkpoints-durable', 'checkpoints', service, checkpoints.evidence, runtimeFile, 'assistant-durable'),
    edge(facts, 'edge:fresh-v2/service-calls-evidence', 'calls', service, tx.evidence, runtimeFile, 'calls-evidence'),
    edge(facts, 'edge:fresh-v2/evidence-transitions-running', 'transitions', tx.evidence, states.running, domainFile, 'evidence-running'),
    edge(facts, 'edge:fresh-v2/evidence-mutates-attempt', 'mutates', tx.evidence, attempt, domainFile, 'evidence-mutates-attempt'),
    edge(facts, 'edge:fresh-v2/evidence-mutates-dispatch', 'mutates', tx.evidence, dispatch, domainFile, 'evidence-mutates-dispatch'),
    edge(facts, 'edge:fresh-v2/service-reads-attempt-fence', 'reads', service, fences.attempt, runtimeFile, 'reads-attempt-fence'),
    edge(facts, 'edge:fresh-v2/service-reads-prompt-fence', 'reads', service, fences.prompt, runtimeFile, 'reads-prompt-fence'),
    edge(facts, 'edge:fresh-v2/service-reads-dispatch-fence', 'reads', service, fences.dispatch, runtimeFile, 'reads-dispatch-fence'),
    ...Object.entries(predicates).map(([name, value]) => edge(facts, `edge:fresh-v2/service-reads-${name}-predicate`, 'reads', service, value, runtimeFile, `reads-${name}-predicate`)),
    edge(facts, 'edge:fresh-v2/flow-verified-runtime', 'verified-by', flow, tests.runtime, runtimeFile, 'verified-runtime'),
    edge(facts, 'edge:fresh-v2/flow-verified-fold', 'verified-by', flow, tests.fold, foldFile, 'verified-fold'),
    edge(facts, 'edge:fresh-v2/flow-verified-foundation', 'verified-by', flow, tests.foundation, domainFile, 'verified-foundation'),
    edge(facts, 'edge:fresh-v2/flow-verified-profile', 'verified-by', flow, tests.profile, 'scripts/a1b/run-profile-smoke.mjs', 'verified-profile'),
    edge(facts, 'edge:fresh-v2/flow-documented-blueprint', 'documented-by', flow, document, 'docs/development/2026-08-24-team-runtime-architecture-blueprint-v1.md', 'documented-blueprint'),
  )
  nodes.sort((left, right) => compareText(left.id, right.id))
  edges.sort((left, right) => compareText(left.id, right.id))
  return { nodes, edges }
}

export function mergeFreshV2InitialDispatchSlice(manifest, slice) {
  const nodeIds = new Set(slice.nodes.map(item => item.id))
  const edgeIds = new Set(slice.edges.map(item => item.id))
  const merged = structuredClone(manifest)
  merged.nodes = [...merged.nodes.filter(item => !nodeIds.has(item.id) && !item.tags?.includes('kg1-d2')), ...structuredClone(slice.nodes)].sort((left, right) => compareText(left.id, right.id))
  merged.edges = [...merged.edges.filter(item => !edgeIds.has(item.id) && !item.id.startsWith('edge:fresh-v2')), ...structuredClone(slice.edges)].sort((left, right) => compareText(left.id, right.id))
  return merged
}
