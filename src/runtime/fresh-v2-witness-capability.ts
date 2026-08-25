import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { TeamDomainError } from '../domain/error.js'
import { canonicalV2Digest } from '../protocol/canonical-v2.js'

const SENTINEL_MODEL = 'dsh-agent-swarm-witness-sentinel'
const LISTENER_GRAPH_CONTRACT = Object.freeze({
  agentRequest: 'global-prepend',
  llmStream: 'global-prepend',
  sessionEvent: 'global',
  topologyPolicy: 'revoke-until-profile-restart',
})

interface ActiveWitnessCapability {
  readonly digest: string
  readonly providers: readonly string[]
}

/** Fixed-Profile proof that the fresh-v2 witness still precedes every LLM route. */
export class FreshV2WitnessCapability {
  private readonly sentinels = new WeakSet<GenerateOptions>()
  private readonly captured = new WeakSet<GenerateOptions>()
  private active: ActiveWitnessCapability | undefined
  private activation: Promise<string> | undefined
  private revokedReason?: string
  private topologyGeneration = 0

  constructor(
    private readonly ctx: Context,
    private readonly artifactContract: string,
    private readonly hostContract: string,
  ) {}

  get digest(): string {
    if (this.active === undefined) {
      throw new TeamDomainError(
        `fresh-v2 model witness capability is unavailable${this.revokedReason === undefined ? '' : `: ${this.revokedReason}`}`,
        'TEAM_RUNTIME_NOT_STARTED',
      )
    }
    return this.active.digest
  }

  /** Publish once, lazily, after the target route and all A1b listeners exist. */
  async activate(): Promise<string> {
    if (this.active !== undefined || this.revokedReason !== undefined) {
      throw new TeamDomainError('fresh-v2 witness capability cannot be republished in a live Profile', 'TEAM_RUNTIME_NOT_STARTED')
    }
    if (this.activation !== undefined) return await this.activation
    const generation = this.topologyGeneration
    const providers = this.providerIds()
    const activation = (async (): Promise<string> => {
      await this.probe(providers)
      const current = this.providerIds()
      if (this.revokedReason !== undefined || generation !== this.topologyGeneration
        || current.length !== providers.length
        || current.some((provider, index) => provider !== providers[index])) {
        throw new TeamDomainError('fresh-v2 witness topology changed during activation', 'TEAM_RUNTIME_NOT_STARTED')
      }
      const digest = canonicalV2Digest('dsh-agent-swarm/a1b/model-dispatch-witness/v2', {
        artifactContract: this.artifactContract,
        hostContract: this.hostContract,
        listenerGraph: LISTENER_GRAPH_CONTRACT,
        providers,
      })
      this.active = { digest, providers }
      return digest
    })()
    this.activation = activation
    try {
      return await activation
    } catch (error) {
      this.revokedReason ??= 'initial LLM listener-order sentinel failed'
      throw error
    } finally {
      if (this.activation === activation) this.activation = undefined
    }
  }

  /** Re-probe ordering before admission, but never accept a changed provider topology. */
  async assertCurrent(): Promise<string> {
    if (this.active === undefined && this.revokedReason === undefined) return await this.activate()
    const active = this.requireActive()
    const providers = this.providerIds()
    if (providers.length !== active.providers.length
      || providers.some((provider, index) => provider !== active.providers[index])) {
      this.revoke('official LLM provider topology changed')
      return this.digest
    }
    try {
      await this.probe(providers)
    } catch (error) {
      this.revoke('LLM listener-order sentinel failed')
      throw error
    }
    return active.digest
  }

  assertDigest(expected: string): void {
    if (this.digest !== expected) {
      throw new TeamDomainError('fresh-v2 model witness capability no longer matches the Attempt', 'TEAM_ATTEMPT_STALE')
    }
  }

  revoke(reason = 'official LLM topology changed', force = false): void {
    this.topologyGeneration += 1
    if (!force && this.active === undefined && this.activation === undefined) return
    this.active = undefined
    this.revokedReason ??= reason
  }

  /** Return a network-free terminal stream only for an exact process-local sentinel. */
  intercept(options: GenerateOptions): AsyncIterable<StreamChunk> | undefined {
    if (!this.sentinels.has(options)) return undefined
    this.captured.add(options)
    return (async function* (): AsyncIterable<StreamChunk> {
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  }

  private requireActive(): ActiveWitnessCapability {
    // Route all unavailable diagnostics through the public getter.
    void this.digest
    return this.active!
  }

  private providerIds(): string[] {
    const llm = this.ctx.get('llm')
    if (llm === undefined) {
      throw new TeamDomainError('fresh-v2 witness requires the official LLM registry', 'TEAM_RUNTIME_NOT_STARTED')
    }
    return llm.listProviders().map(provider => provider.id).toSorted()
  }

  private async probe(providers: readonly string[]): Promise<void> {
    if (providers.length === 0) {
      throw new TeamDomainError('fresh-v2 witness requires at least one official LLM provider route', 'TEAM_RUNTIME_NOT_STARTED')
    }
    const llm = this.ctx.get('llm')
    if (llm === undefined) {
      throw new TeamDomainError('fresh-v2 witness requires the official LLM registry', 'TEAM_RUNTIME_NOT_STARTED')
    }
    for (const provider of providers) {
      const options: GenerateOptions = { provider, model: SENTINEL_MODEL, messages: [] }
      this.sentinels.add(options)
      try {
        for await (const chunk of llm.stream(options)) {
          void chunk
          // Fully consume the terminal sentinel so the waterfall is exercised.
        }
        if (!this.captured.has(options)) {
          throw new TeamDomainError(
            `fresh-v2 witness is bypassed by an earlier llm/stream terminal route for provider "${provider}"`,
            'TEAM_RUNTIME_NOT_STARTED',
          )
        }
      } finally {
        this.sentinels.delete(options)
        this.captured.delete(options)
      }
    }
  }
}
