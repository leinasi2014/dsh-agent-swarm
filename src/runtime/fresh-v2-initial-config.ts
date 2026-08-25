import type { FreshV2InitialRuntime } from './fresh-v2-initial-runtime.js'

export interface FreshV2InitialConfig {
  readonly artifactContract: string
  readonly hostContract: string
  readonly legacyManifestCapacity: number
  readonly memberProvider: string
  readonly memberLlmProvider?: string
  readonly memberModel?: string
  readonly memberDenyTools: readonly string[]
  readonly memberSkills: readonly string[]
  readonly memberMaxDepth: number
  readonly maxMembers: number
  readonly maxVerificationCommands: number
  readonly maxVerificationCommandMs: number
  readonly disposalTimeoutMs: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentSwarmV2Initial: FreshV2InitialRuntime
  }
}
