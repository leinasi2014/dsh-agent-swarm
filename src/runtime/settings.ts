import type { Context } from '@deepseek-ai/cordis'
import type z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { Config } from '../index.js'
import type { MemoryQuerySettings } from './memory-query.js'

export const AGENT_SWARM_SETTINGS_NAMESPACE = settingsNamespace('agent-swarm')

export interface AgentSwarmLiveSettings {
  readonly memory: MemoryQuerySettings
  readonly memberProvider: string
  readonly memberLlmProvider?: string
  readonly memberModel?: string
  readonly memberDenyTools: readonly string[]
  readonly memberSkills: readonly string[]
}

export function installAgentSwarmSettings(
  ctx: Context,
  schema: z<Config>,
  entry: Config,
  fallbackMemberProvider: string,
): () => AgentSwarmLiveSettings {
  let source = (): Config => entry
  installSettingsSection(ctx, AGENT_SWARM_SETTINGS_NAMESPACE, schema, entry, {
    setSource: current => { source = current },
    onChange: () => {},
    validate(value) {
      const missingSemanticRoute = value.memorySemanticProvider?.trim() === ''
        || value.memorySemanticModel?.trim() === ''
        || value.memorySemanticProvider === undefined
        || value.memorySemanticModel === undefined
      if (value.memorySemanticEnabled === true && missingSemanticRoute) {
        throw new Error('agent-swarm: semantic memory search requires both memorySemanticProvider and memorySemanticModel')
      }
      if ((value.memberProvider ?? 'spawn').trim() === '') throw new Error('agent-swarm: memberProvider must not be empty')
    },
  })
  return () => {
    const current = source()
    return {
      memory: {
        semanticEnabled: current.memorySemanticEnabled ?? false,
        ...(current.memorySemanticProvider === undefined ? {} : { semanticProvider: current.memorySemanticProvider }),
        ...(current.memorySemanticModel === undefined ? {} : { semanticModel: current.memorySemanticModel }),
        maxCandidates: current.memoryQueryMaxCandidates ?? 32,
        timeoutMs: current.memoryQueryTimeoutMs ?? 15_000,
      },
      memberProvider: (current.memberProvider ?? fallbackMemberProvider).trim(),
      ...(current.memberLlmProvider === undefined ? {} : { memberLlmProvider: current.memberLlmProvider }),
      ...(current.memberModel === undefined ? {} : { memberModel: current.memberModel }),
      memberDenyTools: current.memberDenyTools ?? [],
      memberSkills: current.memberSkills ?? [],
    }
  }
}
