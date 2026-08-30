/** Stable DSH plugin entry. Implementation lives under `plugin/`. */
export * from './public-api.js'
export { apply } from './plugin/apply.js'
export { AGENT_SWARM_SETTINGS_NAMESPACE, Config } from './plugin/config.js'

export const name = 'agent-swarm'
export const inject = [
  'tools',
  'subagents',
  'agents',
  'sessions',
  'systemPrompt',
  'sessionPersistence',
  'storageDomain',
] as const
