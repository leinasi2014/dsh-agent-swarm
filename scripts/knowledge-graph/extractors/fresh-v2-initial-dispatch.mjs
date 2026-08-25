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
    'options.signal !== permit.signal',
    'enterInitialDispatch(',
    'settleInitialAssistantEvidence(',
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
  ],
  'src/domain/team-domain-v2-continuation-recovery.ts': [
    'async reserveProvenNotEntered(',
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
    'export function claimedContinuationFrame(',
    'export function currentContinuationAttempt(',
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
    'does not report running when the official adapter fails at iteration',
  ],
  'tests/fresh-v2-continuation-domain.spec.ts': [
    'persists request before parking, admits one effect, and returns the same Attempt to running only after assistant evidence',
    'is idempotent for one identity and rejects stale, forged, or competing continuation requests',
  ],
  'tests/fresh-v2-continuation-runtime.spec.ts': [
    'runs two official turns under one Attempt and refuses a later unframed wake',
  ],
  'tests/fresh-v2-continuation-restart.spec.ts': [
    'reserves exactly one recovery epoch for a cold pending dispatch without replaying the frame or Provider call',
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
      'cold-recovery-trigger-undelivered',
      'cold-dispatch-entered-unclassified',
      'cold-evidence-unrefolded',
      'provider-start-result-unknown',
    ],
  }
  facts.digest = taggedSha256('dsh-agent-swarm/kg1-d2/facts/v1', facts)
  return validateFreshV2InitialDispatchFacts(facts)
}
