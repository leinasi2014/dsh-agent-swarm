import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { taggedSha256 } from '../canonical.mjs'
import { fail } from '../diagnostics.mjs'

const SLICE_ID = 'fresh-v2-initial-dispatch-v1'
const REQUIRED = Object.freeze({
  'src/index.ts': [
    'if (config.experimentalFreshV2 === true)',
    'attachFreshV2Hooks(ctx, runtime)',
    'await runtime.reconcileColdDispatches()',
    'await runtime.driveColdRecoveries()',
    'registerFreshV2AgentSwarmTools(ctx, runtime)',
  ],
  'src/tools.ts': [
    'export function registerFreshV2AgentSwarmTools(',
    'registerSubmitTaskTool(ctx, runtime)',
    'registerReassignTaskTool(ctx, runtime)',
  ],
  'src/runtime/fresh-v2-hooks.ts': [
    "ctx.on('agent/request'",
    "ctx.on('llm/stream'",
    "ctx.on('session/event'",
    "ctx.on('agent/inbox/claimed'",
    "ctx.on('agent/status'",
    "ctx.on('llm/adapters-updated'",
  ],
  'src/runtime/fresh-v2-initial-runtime.ts': [
    'createAndReserveInitialAssignment(',
    'this.ctx.subagents.startContinuable({',
    'failInitialAssignment(',
    'settleInitialAssignment(',
    'this.modelPermits.set(input.agent.id',
    'ownsFreshV2InitialModelDispatch(',
    'enterInitialDispatch(',
    'settleInitialAssistantEvidence(',
    'this.requireInitialOutcomes().reconcileColdDispatches()',
    'this.requireInitialOutcomes().foldTurnEnd(session, event)',
    'retireTurnPermit(session.id, event.data.turn)',
    'this.requireTaskControl().submitTask(',
    'this.requireTaskControl().reassignTask(',
  ],
  'src/runtime/fresh-v2-initial-model-gate.ts': [
    'export function ownsFreshV2InitialModelDispatch(',
    'ownsFreshV2ModelPermit(',
    'initial dispatch permit lost its exact Attempt',
  ],
  'src/runtime/fresh-v2-model-permit.ts': [
    'export function ownsFreshV2ModelPermit(',
    'AgentLoop request conflicts with its',
    'export function consumeFreshV2ModelPermit(',
    'export function retireFreshV2ModelPermit(',
  ],
  'src/runtime/fresh-v2-evidence-coordinator.ts': [
    "event.type !== 'assistant/message'",
    'this.ctx.sessions.flush(session)',
    'this.callbacks.assistant(session, event)',
  ],
  'src/domain/team-domain-v2-start.ts': [
    'async createAndReserveInitialAssignment(',
    'async settleInitialAssignment(',
    'async failInitialAssignment(',
    'async enterInitialDispatch(',
    'async settleInitialAssistantEvidence(',
  ],
  'src/domain/team-domain-v2-initial-outcome.ts': [
    'export class TeamV2InitialOutcomeDomain',
    'async settleTurnEnd(',
    'async markUnknown(',
    'async settleAssistantAndPark(',
  ],
  'src/runtime/fresh-v2-initial-outcome-fold.ts': [
    'export function foldEnteredInitialOutcome(',
  ],
  'src/runtime/fresh-v2-initial-outcome-recovery.ts': [
    'export class FreshV2InitialOutcomeRecovery',
    'async foldTurnEnd(',
    'async reconcileColdDispatches()',
    'this.ctx.sessionPersistence.prepare(',
  ],
  'src/domain/team-state-v2.ts': [
    'export interface ModelDispatchEpoch',
    'export interface TaskAttemptV2',
  ],
  'src/runtime/fresh-v2-continuation-runtime.ts': [
    'this.domain.requestMemberContinuation(',
    'this.domain.parkAfterTurn(',
    'this.domain.admitRequested(',
    'this.ctx.subagents.followup(',
    'this.domain.claimFrame(',
    'this.domain.enterDispatch(',
    'this.domain.settleAssistantEvidence(',
    'this.recoveryDomain.reserveProvenNotEntered(',
    'currentStepContainsContinuationFrame(',
    'ownsFreshV2ModelPermit(',
    'retireTurnPermit(sessionId: string, turn: number)',
  ],
  'src/domain/team-domain-v2-task-control.ts': [
    'function closeAttemptControl(',
    'async submitTask(',
    'async reassignTask(',
  ],
  'src/runtime/fresh-v2-task-control-runtime.ts': [
    'export class FreshV2TaskControlRuntime',
    'this.domain.submitTask(',
    'this.domain.reassignTask(',
    'this.ctx.subagents.interrupt(',
  ],
  'src/domain/team-domain-v2-continuation-recovery.ts': [
    'async reserveProvenNotEntered(',
    'async claimRecoveryFrame(',
  ],
  'src/runtime/fresh-v2-recovery-driver.ts': [
    'export class FreshV2RecoveryDriver',
    'this.ctx.subagents.followup(',
    'this.domain.claimRecoveryFrame(',
    'foldPendingContinuationRecovery(',
    'this.domain.reserveProvenNotEntered(',
  ],
  'src/runtime/fresh-v2-continuation-recovery-fold.ts': [
    'export function foldPendingContinuationRecovery(',
  ],
  'src/domain/team-domain-v2-continuation.ts': [
    'async requestMemberContinuation(',
    'async parkAfterTurn(',
    'async admitRequested(',
    'async recordFrameAccepted(',
    'async claimFrame(',
    'async enterDispatch(',
    'async settleAssistantEvidence(',
  ],
  'src/runtime/fresh-v2-continuation-fold.ts': [
    'export function continuationFrame(',
    'function continuationRecoveryFrame(',
    'export function claimedContinuationFrame(',
    'export function durableClaimedContinuationFrame(',
    'export function currentContinuationAttempt(',
    'export function stagedContinuationRecovery(',
  ],
  'src/runtime/fresh-v2-session-fold.ts': [
    'export function initialPromptDigest(',
    'export function claimedInitialFrame(',
    'export function assistantEvidenceAt(',
  ],
  'src/runtime/fresh-v2-witness-capability.ts': [
    'async activate(): Promise<string>',
    'async assertCurrent(): Promise<string>',
    'this.revoke(\'official LLM provider topology changed\')',
    'intercept(options: GenerateOptions)',
  ],
  'tests/fresh-v2-initial-runtime.spec.ts': [
    'keeps add_member dormant, witnesses provider entry, then admits running from durable assistant evidence',
    'settles an entered initial dispatch from the durable Provider error boundary without reporting running',
  ],
  'tests/fresh-v2-initial-outcome-restart.spec.ts': [
    "describe('fresh-v2 initial entered-outcome cold reconciliation'",
    'folds %s without replay and stays idempotent after a second restart',
  ],
  'tests/fresh-v2-task-control-runtime.spec.ts': [
    'accepts submit only through a real official Agent Loop tool-call after assistant evidence',
    'fences captain reassignment before interrupting an entered Provider',
    'blocks Provider entry when captain reassigns after agent/request issued its one-shot permit',
    'This ordinary unframed followup must remain usable after permit retirement.',
  ],
  'tests/fresh-v2-task-control-domain.spec.ts': [
    'rejects submission until official assistant execution evidence makes the Attempt running',
    'lets the exact member submit a running Attempt without completing the task',
    'atomically supersedes continuation and staged recovery receipts when captain reassigns',
    'derives submit and reassign authority from the exact Team actor',
  ],
  'tests/fresh-v2-continuation-domain.spec.ts': [
    'persists request before parking, admits one effect, and returns the same Attempt to running only after assistant evidence',
    'is idempotent for one identity and rejects stale, forged, or competing continuation requests',
  ],
  'tests/fresh-v2-continuation-runtime.spec.ts': [
    'runs two official turns under one Attempt and refuses a later unframed wake',
    'settles an entered continuation from its durable Provider error boundary without replay',
  ],
  'tests/fresh-v2-continuation-restart.spec.ts': [
    'reserves exactly one recovery epoch for a cold pending dispatch without replaying the frame or Provider call',
    'delivers one typed recovery trigger and enters Provider only after atomic recovery handoff',
    'cold-folds a claimed recovery frame without redelivery and stages its next safe recovery',
    'fails closed on a durably pending recovery inbox frame instead of duplicating it',
  ],
  'tests/fresh-v2-continuation-fold.spec.ts': [
    "describe('A2a exact continuation-frame fold'",
  ],
  'tests/fresh-v2-witness-capability.spec.ts': [
    'revokes after provider topology mutation and never republishes',
    'rejects a newly prepended short-circuit route before Team admission',
    'cannot publish stale capability when topology changes during activation',
    'singleflights concurrent first capability assertions',
    'cannot publish capability after disposal starts during activation',
  ],
  'tests/fresh-v2-session-fold.spec.ts': ['describe('],
  'tests/team-v2-foundation.spec.ts': ['describe('],
  'scripts/a1b/run-profile-smoke.mjs': ['A1b official Profile DEV_SMOKE PASS'],
  'docs/development/2026-08-24-team-runtime-architecture-blueprint-v1.md': ['A1b'],
})

function lineOf(text, fragment) {
  const index = text.indexOf(fragment)
  if (index < 0) return undefined
  return text.slice(0, index).split('\n').length
}

export function validateFreshV2InitialDispatchFacts(facts) {
  if (facts?.sliceId !== SLICE_ID) fail('KG_FRESH_V2_SLICE', 'fresh-v2 semantic fact slice id drifted')
  for (const [file, fragments] of Object.entries(REQUIRED)) {
    const fact = facts.files?.find(item => item.file === file)
    if (fact === undefined) fail('KG_FRESH_V2_SOURCE', `fresh-v2 source fact is missing: ${file}`)
    for (const fragment of fragments) {
      if (!fact.fragments.some(item => item.fragment === fragment && Number.isSafeInteger(item.line))) {
        fail('KG_FRESH_V2_CONTROL_FLOW', `fresh-v2 required control-flow fact is missing: ${file}: ${fragment}`)
      }
    }
  }
  return facts
}

export async function extractFreshV2InitialDispatchFacts(rootInput, options = {}) {
  const root = resolve(rootInput)
  const files = []
  for (const [file, fragments] of Object.entries(REQUIRED)) {
    const text = options.sourceOverrides?.[file] ?? await readFile(resolve(root, file), 'utf8')
    const observed = fragments.map(fragment => ({ fragment, line: lineOf(text, fragment) }))
    for (const item of observed) {
      if (item.line === undefined) fail('KG_FRESH_V2_CONTROL_FLOW', `fresh-v2 required control-flow fact is missing: ${file}: ${item.fragment}`)
    }
    files.push({
      file,
      digest: taggedSha256('dsh-agent-swarm/kg1-d2/file/v1', text.replaceAll('\r\n', '\n')),
      fragments: observed,
    })
  }
  const facts = {
    sliceId: SLICE_ID,
    files,
    absentRecoveryBranches: [
      'cold-starting-unreconciled',
      'cold-recovery-pending-capability-blocked',
      'provider-start-result-unknown',
    ],
  }
  facts.digest = taggedSha256('dsh-agent-swarm/kg1-d2/facts/v1', facts)
  return validateFreshV2InitialDispatchFacts(facts)
}
