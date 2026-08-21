/**
 * Review execution root Provider family (M3-2, issue #101; ADR-0008 D2).
 *
 * A review execution root is an ISOLATED read-and-run verification face:
 * candidate artifacts are checked in by the reviewer, and the task's
 * captain-declared verification commands execute inside the root with a
 * bounded timeout. Evidence (exit code, duration, output) is produced only
 * by the root — the reviewed party holds no handle on it, so the diagnostic
 * of an executable review cannot be forged by the worker.
 *
 * This is the review-permission face of the execution-root Provider family
 * issue #100 (M3-1) establishes for per-attempt WORK roots: same family
 * shape, different authority. #100 owns execution-root supply for members;
 * the builtin here is a plain temp directory and the interface is reserved
 * so a future Provider can back both faces with real isolation (worktree,
 * container) without touching the review transaction. The default root is
 * process-local and throws on every failure — never silently degrading to
 * "verification skipped".
 */
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { TaskAttempt, TeamState, TeamTask } from '../domain/types.js'
import { TeamDomainError } from '../domain/error.js'

/** Structured outcome of one verification command inside the root. */
export interface ReviewCommandEvidence {
  readonly command: string
  /** Process exit code; null when the process never produced one (spawn failure or kill). */
  readonly exitCode: number | null
  readonly timedOut: boolean
  /** The bounded deadline that applied to this execution. */
  readonly timeoutMs: number
  readonly durationMs: number
  readonly stdout: string
  readonly stderr: string
  /** Set when the command could not even be spawned (counts as failure). */
  readonly spawnError?: string
}

/** One opened review execution root. */
export interface ReviewRootSession {
  /** Stable short label for diagnostics (not a full path). */
  readonly label: string
  /** Absolute root path commands execute in (cwd). */
  readonly root: string
  /** Check one candidate artifact into the root before verification runs. */
  checkIn(name: string, content: string): Promise<void>
  /** Run one command inside the root under a bounded timeout. */
  run(command: string, options: { readonly timeoutMs: number; readonly signal: AbortSignal }): Promise<ReviewCommandEvidence>
  /** Release the root. Best-effort cleanup of the isolated face. */
  close(): Promise<void>
}

/** Opening input of one review root: the exact artifacts under review. */
export interface ReviewRootOpenInput {
  readonly team: TeamState
  readonly task: TeamTask
  readonly attempt: TaskAttempt
  readonly signal: AbortSignal
}

/**
 * Replaceable review execution root supply (project-owned seam: official DSH
 * owns workspace IDENTITY, not execution roots — docs/11 §4). The #100
 * execution-root Provider family is the sibling face of this contract.
 */
export interface ReviewRootProvider {
  open(input: ReviewRootOpenInput): Promise<ReviewRootSession>
}

/** Check-in names are single safe segments: no traversal, no separators. */
const SAFE_ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** Per-stream output capture bound: a runaway command cannot exhaust memory. */
const MAX_CAPTURED_BYTES_PER_STREAM = 65_536

interface Capture {
  chunks: Buffer[]
  truncated: boolean
}

function capture(stream: NodeJS.ReadableStream | null | undefined): Capture {
  const state: Capture = { chunks: [], truncated: false }
  if (stream === undefined || stream === null) return state
  let bytes = 0
  stream.on('data', (chunk: Buffer) => {
    if (bytes + chunk.byteLength > MAX_CAPTURED_BYTES_PER_STREAM) {
      state.truncated = true
      stream.pause()
      return
    }
    state.chunks.push(chunk)
    bytes += chunk.byteLength
  })
  return state
}

function decoded(state: Capture): string {
  const text = state.chunks.map(chunk => chunk.toString('utf8')).join('') + (state.truncated ? '…[captured output truncated]' : '')
  return text.replace(/\r\n/g, '\n')
}

/**
 * Builtin `temp` review root (the M3-2 default): one fresh temp directory
 * per review, candidate artifacts checked in as files, commands executed
 * with `cwd` confined to the root, killed (process tree on Windows) at the
 * timeout, removed on close. Reserved for a #100-family Provider to replace
 * with real isolation.
 */
export function tempReviewRootProvider(): ReviewRootProvider {
  return {
    async open(input) {
      input.signal.throwIfAborted()
      let root: string
      try {
        root = await mkdtemp(join(tmpdir(), 'agent-swarm-review-'))
      } catch (error) {
        // Fail loud: no root, no verification, no settled review transaction.
        throw new TeamDomainError(
          `review execution root unavailable: ${error instanceof Error ? error.message : String(error)}`,
          'TEAM_REVIEW_ROOT_UNAVAILABLE',
          { cause: error },
        )
      }
      return {
        label: basename(root),
        root,
        async checkIn(name, content) {
          if (!SAFE_ARTIFACT_NAME.test(name)) {
            throw new TeamDomainError(`review artifact name "${name}" is not a safe single path segment`, 'TEAM_INPUT_INVALID')
          }
          await writeFile(join(root, name), content, 'utf8')
        },
        run(command, options) {
          return new Promise<ReviewCommandEvidence>(resolve => {
            const startedAt = Date.now()
            let child: ReturnType<typeof spawn>
            try {
              child = spawn(command, { shell: true, cwd: root, windowsHide: true, env: process.env })
            } catch (error) {
              resolve({
                command,
                exitCode: null,
                timedOut: false,
                timeoutMs: options.timeoutMs,
                durationMs: Date.now() - startedAt,
                stdout: '',
                stderr: '',
                spawnError: error instanceof Error ? error.message : String(error),
              })
              return
            }
            const stdout = capture(child.stdout)
            const stderr = capture(child.stderr)
            const deadline = AbortSignal.timeout(options.timeoutMs)
            const killTree = (): void => {
              if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
              if (process.platform === 'win32') {
                // Kill the whole spawned tree: a bare TerminateProcess of
                // cmd.exe leaves shell grandchildren running.
                spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
                  .on('error', () => child.kill())
              } else {
                child.kill('SIGKILL')
              }
            }
            const onDeadline = (): void => killTree()
            deadline.addEventListener('abort', onDeadline, { once: true })
            options.signal.addEventListener('abort', killTree, { once: true })
            child.on('error', error => {
              if (deadline.aborted) return
              resolve({
                command,
                exitCode: null,
                timedOut: false,
                timeoutMs: options.timeoutMs,
                durationMs: Date.now() - startedAt,
                stdout: decoded(stdout),
                stderr: decoded(stderr),
                spawnError: error instanceof Error ? error.message : String(error),
              })
            })
            child.on('close', code => {
              resolve({
                command,
                exitCode: code,
                timedOut: deadline.aborted,
                timeoutMs: options.timeoutMs,
                durationMs: Date.now() - startedAt,
                stdout: decoded(stdout),
                stderr: decoded(stderr),
              })
            })
          })
        },
        async close() {
          await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
        },
      }
    },
  }
}
