/**
 * Builtin `executable` review Provider (M3-2, issue #101; ADR-0008 D2).
 *
 * Executes the task's captain-declared verification commands inside an
 * isolated review execution root and composes the review diagnostic
 * EXCLUSIVELY from that execution (exit codes, durations, output
 * summaries). Forced evidence retention: every review this Provider settles
 * carries root-produced evidence; the reviewed party has no parameter path
 * into the diagnostic — the worker's submission is checked in as the
 * candidate artifact under review (data, never a verdict).
 *
 * Fail-loud family (docs/04 §5): a root that cannot be opened fails the
 * review transaction immediately (`TEAM_REVIEW_ROOT_UNAVAILABLE`) — the
 * task stays `submitted`, nothing settles and nothing hangs; a failed,
 * unspawnable or timed-out command forces the reject path with the evidence
 * attached; a passed command list never overrides a captain's reject
 * request (verification is a floor, not a ceiling). The review
 * transaction's existing semantics are untouched: `submitted` never
 * completes itself — this Provider runs only inside the captain's review
 * call, exactly like `manual` and the canvas human bridge.
 */
import type { ReviewProviderInput, ReviewProviderResult, TeamReviewProvider } from './providers.js'
import {
  assertReviewRootCapabilityAvailable,
  type ReviewCommandEvidence,
  type ReviewRootCapabilities,
  type ReviewRootProvider,
  type ReviewRootSession,
} from './review-root.js'
import { TeamDomainError } from '../domain/error.js'
import { parseVerificationCommand } from './verification-commands.js'
import {
  aggregateVerificationEvidence,
  type RoutedReviewCommandEvidence,
  type VerificationEvidenceSummary,
} from './verification-summary.js'

/** Candidate artifact name the submitted output is checked in under. */
export const CANDIDATE_OUTPUT_ARTIFACT = 'candidate-output.md'

/** Bounded per-command output snippet inside the diagnostic. */
const SNIPPET_CHARS = 400

/** Hard diagnostic budget below the domain's 8192-byte bound. */
const DIAGNOSTIC_BUDGET = 8_000

export interface ExecutableReviewOptions {
  /** Resolves the configured review-root Provider (undefined = missing). */
  readonly resolveRoot: (name: string) => ReviewRootProvider | undefined
  /** Resolves M4B capability metadata for a registered root family. */
  readonly resolveRootCapabilities?: (name: string) => ReviewRootCapabilities | undefined
  /** Configured review-root Provider name. */
  readonly rootProviderName: () => string
  /** Default per-command timeout when the task declares none. */
  readonly defaultCommandTimeoutMs: number
  /** Hard per-command timeout ceiling (the domain limit). */
  readonly maxCommandTimeoutMs: number
  /** Warn sink for best-effort root cleanup failures. */
  readonly warn?: (message: string) => void
}

/** Executable Provider result with its complete root-produced aggregation. */
export interface ExecutableReviewResult extends ReviewProviderResult {
  readonly verificationSummary: VerificationEvidenceSummary
}

/** Team Review Provider whose direct Consumer also receives structured evidence. */
export interface ExecutableReviewProvider extends TeamReviewProvider {
  review(input: ReviewProviderInput): Promise<ExecutableReviewResult>
}

function snippet(text: string): string {
  const normalized = text.trim()
  if (normalized === '') return ''
  return normalized.length <= SNIPPET_CHARS ? normalized : `${normalized.slice(0, SNIPPET_CHARS)}…[truncated]`
}

function commandFailed(evidence: ReviewCommandEvidence): boolean {
  return evidence.timedOut || evidence.spawnError !== undefined || evidence.exitCode === null || evidence.exitCode !== 0
}

function failureReason(evidence: ReviewCommandEvidence): string {
  if (evidence.timedOut) return 'timed out after the bounded deadline'
  if (evidence.spawnError !== undefined) return `spawn error: ${evidence.spawnError}`
  if (evidence.exitCode === null) return 'produced no exit code'
  return `exit code ${evidence.exitCode}`
}

function effectiveTimeoutMs(command: { readonly timeoutMs?: number }, options: ExecutableReviewOptions): number {
  const declared = command.timeoutMs ?? options.defaultCommandTimeoutMs
  return Math.min(Math.max(Math.trunc(declared), 1), options.maxCommandTimeoutMs)
}

function evidenceLines(records: readonly RoutedReviewCommandEvidence[], total: number): string[] {
  return records.flatMap((record) => {
    const item = record.evidence
    const lines = [
      `[${record.index + 1}/${total}] root=${record.family}(${record.rootLabel}) exit=${item.exitCode === null ? 'none' : item.exitCode} ${item.timedOut ? 'TIMED-OUT ' : ''}${item.durationMs}ms cmd: ${item.command}`,
    ]
    const out = snippet(item.stdout)
    const err = snippet(item.stderr)
    if (err !== '') lines.push(`  stderr: ${err}`)
    if (out !== '') lines.push(`  stdout: ${out}`)
    if (item.spawnError !== undefined) lines.push(`  spawn-error: ${snippet(item.spawnError)}`)
    return lines
  })
}

/**
 * Render the diagnostic. The verdict and provenance lines are kept
 * tail-first outside the shrinking evidence budget so a bounded output can
 * never push the decision basis out of the stored diagnostic.
 */
function renderDiagnostic(
  attemptId: string,
  summary: VerificationEvidenceSummary,
): string {
  const failed = summary.failedCommandIndex === undefined
    ? undefined
    : summary.commands.find(command => command.index === summary.failedCommandIndex)?.evidence
  const verdict = summary.failedCommandIndex === undefined
    ? `verification PASSED: ${summary.executedCommands}/${summary.plannedCommands} command(s) exited 0; captain request "${summary.requestedDecision}" stands`
    : `verification FAILED at command ${summary.failedCommandIndex + 1}/${summary.plannedCommands}: ${failureReason(failed!)}; rejected regardless of the captain request`
  const lines = [
    `executable review: attempt=${attemptId} roots=${summary.roots.length} commands=${summary.executedCommands}/${summary.plannedCommands}`,
    ...evidenceLines(summary.commands, summary.plannedCommands),
    verdict,
    'evidence produced solely by the review execution root',
  ]
  let text = lines.join('\n')
  if (text.length > DIAGNOSTIC_BUDGET) {
    // Shrink snippets once, then hard-bound only the evidence prefix. The
    // verdict and provenance must survive even at the maximum command count.
    const verdictLine = lines[lines.length - 2]!
    const provenance = lines[lines.length - 1]!
    const header = lines[0]!
    const evidencePrefix = [header, ...summary.commands.map(record => {
      const item = record.evidence
      return `[${record.index + 1}/${summary.plannedCommands}] root=${record.family}(${record.rootLabel}) exit=${item.exitCode === null ? 'none' : item.exitCode} ${item.timedOut ? 'TIMED-OUT ' : ''}${item.durationMs}ms cmd: ${item.command}`
    })].join('\n')
    const tail = `${verdictLine}\n${provenance}`
    const prefixBudget = Math.max(0, DIAGNOSTIC_BUDGET - tail.length - 1)
    const marker = '…[evidence truncated]'
    const boundedPrefix = evidencePrefix.length <= prefixBudget
      ? evidencePrefix
      : `${evidencePrefix.slice(0, Math.max(0, prefixBudget - marker.length))}${marker}`
    text = boundedPrefix === '' ? tail : `${boundedPrefix}\n${tail}`
  }
  return text
}

interface ResolvedVerificationCommand {
  readonly index: number
  readonly family: string
  readonly capability: string
  readonly command: string
  readonly routed: boolean
  readonly timeoutMs?: number
}

function resolvedCommands(input: ReviewProviderInput, fallbackFamily: string): ResolvedVerificationCommand[] {
  return input.verification.map((declaration, index) => {
    const route = parseVerificationCommand(declaration.command)
    return route === undefined
      ? {
          index,
          family: fallbackFamily,
          capability: 'raw',
          command: declaration.command,
          routed: false,
          ...(declaration.timeoutMs === undefined ? {} : { timeoutMs: declaration.timeoutMs }),
        }
      : {
          index,
          family: route.family,
          capability: route.capability,
          command: route.command,
          routed: true,
          ...(declaration.timeoutMs === undefined ? {} : { timeoutMs: declaration.timeoutMs }),
        }
  })
}

/** Compose the builtin `executable` review Provider over a root supply. */
export function executableReview(options: ExecutableReviewOptions): ExecutableReviewProvider {
  return {
    async review(input: ReviewProviderInput): Promise<ExecutableReviewResult> {
      input.signal.throwIfAborted()
      const commands = resolvedCommands(input, options.rootProviderName())
      const sessions = new Map<string, ReviewRootSession>()
      const opened: ReviewRootSession[] = []
      const openedRoots: Array<{ family: string; capability: string; label: string }> = []
      const checkedAvailability = new Set<string>()
      const evidence: RoutedReviewCommandEvidence[] = []
      let failedCommandIndex: number | undefined
      const openRoot = async (command: ResolvedVerificationCommand): Promise<ReviewRootSession> => {
        const capabilities = options.resolveRootCapabilities?.(command.family)
        if (command.routed && checkedAvailability.has(command.family)
          && (capabilities === undefined || !capabilities.provides.includes(command.capability))) {
          throw new TeamDomainError(
            `review root family "${command.family}" does not provide capability "${command.capability}"`,
            'TEAM_REVIEW_ROOT_UNAVAILABLE',
          )
        }
        const existing = sessions.get(command.family)
        if (existing !== undefined) return existing
        const root = options.resolveRoot(command.family)
        if (root === undefined) {
          throw new TeamDomainError(`review execution root Provider "${command.family}" is unavailable`, 'TEAM_REVIEW_ROOT_PROVIDER_MISSING')
        }
        if (!checkedAvailability.has(command.family)) {
          if (command.routed) {
            await assertReviewRootCapabilityAvailable({
              family: command.family,
              capability: command.capability,
              capabilities,
              signal: input.signal,
            })
          }
          checkedAvailability.add(command.family)
        }
        let session: ReviewRootSession
        try {
          session = await root.open({ team: input.team, task: input.task, attempt: input.attempt, signal: input.signal })
        } catch (error) {
          if (error instanceof TeamDomainError) throw error
          throw new TeamDomainError(
            `review execution root unavailable: ${error instanceof Error ? error.message : String(error)}`,
            'TEAM_REVIEW_ROOT_UNAVAILABLE',
            { cause: error },
          )
        }
        sessions.set(command.family, session)
        opened.push(session)
        openedRoots.push({ family: command.family, capability: command.capability, label: session.label })
        if (input.attempt.output !== undefined && input.attempt.output !== '') {
          await session.checkIn(CANDIDATE_OUTPUT_ARTIFACT, input.attempt.output)
        }
        return session
      }
      try {
        if (commands.length === 0) {
          const family = options.rootProviderName()
          await openRoot({ index: 0, family, capability: 'raw', command: '', routed: false })
        }
        for (const command of commands) {
          input.signal.throwIfAborted()
          const session = await openRoot(command)
          const record = await session.run(command.command, {
            timeoutMs: effectiveTimeoutMs(command, options),
            signal: input.signal,
          })
          evidence.push({
            index: command.index,
            family: command.family,
            capability: command.capability,
            rootLabel: session.label,
            evidence: record,
          })
          if (commandFailed(record)) {
            failedCommandIndex = command.index
            break
          }
        }
      } finally {
        for (const session of opened.toReversed()) {
          await session.close().catch(error => {
            options.warn?.(`agent-swarm: review root cleanup failed: ${String(error)}`)
          })
        }
      }
      const summary = aggregateVerificationEvidence({
        requestedDecision: input.requestedDecision,
        plannedCommands: commands.length,
        commands: evidence,
        openedRoots,
        ...(failedCommandIndex === undefined ? {} : { failedCommandIndex }),
      })
      return {
        decision: summary.finalDecision,
        diagnostic: renderDiagnostic(input.attempt.id, summary),
        verificationSummary: summary,
      }
    },
  }
}
