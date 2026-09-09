import type { RunResult } from './runner.mjs'
export function copyPortableTree(source: string, target: string): Promise<void>
export function resolveApprovedCli(cliSource: string, expectedCli?: string): Promise<string>
export interface CandidateProcess {
  pid: number
  readonly exitCode: number | null
  done: Promise<RunResult>
  stdout(): Promise<string>
  stderr(): Promise<string>
  stop(): Promise<RunResult>
}
export interface CandidateSession {
  root: string
  cli: string
  sourceCli: string
  node: string
  start(command: string, args: string[], options?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number }): Promise<CandidateProcess>
  run(command: string, args: string[], options?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number }): Promise<RunResult>
  stageInput(source: string): Promise<string>
  copyOutput(source: string, destination: string): Promise<void>
  withSource<T>(repo: string, commit: string, fn: (path: string) => Promise<T>): Promise<T>
  dispose(): Promise<void>
}
export function openCandidateSession(privateRoot: string | undefined, controlRun: (command: string, args: string[], options?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> }) => Promise<RunResult>, protectedRoots?: string[], expectedCli?: string): Promise<CandidateSession>
