/** Historical full-token probe; production candidates use the account adapter. */
export function allocatePrivateCandidateRoot(): Promise<string>
export function grantCandidateDirectories(identityRoot: string, directories: string[]): {
  sid: string
  dispose(): void
}

/** Administrator-provisioned local identity; no credentials in argv or env.
 * password is UTF-16LE without a terminator. Caller owns and wipes that buffer.
 * The controller pins expectedSid independently of candidate input. */
export function spawnWindowsAccountCandidate(options: {
  account: string
  password: Buffer
  expectedSid: string
  command: string
  args?: string[]
  cwd: string
  env: Record<string, string>
  stdio?: { stdin: number; stdout: number; stderr: number }
  inheritStdio?: boolean
}): import('@deepseek-ai/dsh-win32-process').SpawnedJobProcess

export function windowsCandidateBindings(): import('@deepseek-ai/dsh-win32-process').Win32ProcessBindings
export function copyWindowsCandidateOutput(root: string, source: string, destination: string): Promise<void>
