/**
 * The standalone Skills-management function plugin: opens its own official
 * Storage Domain, constructs the module, provides `agentSwarmSkills`, and
 * disposes in the required order — close admission → drain queued writes →
 * release only the module's own manager AgentHandle (business Agents are
 * never disposed) → close store → close the domain.
 *
 * This plugin ships as its OWN package subpath `dsh-agent-swarm/skills`
 * (built as `lib/skills.mjs` in the SAME build graph as the Host main entry,
 * so official error classes and symbols stay singletons across entries). The
 * Host mounts this namespace directly — exactly like every other official
 * plugin — with its own explicit management manifest and manager model
 * route; the shared `plugin/apply.ts` does NOT mount it. Model routing is
 * the module's OWN config (manager provider/model), deliberately separate
 * from the Team/Captain default route.
 *
 * @module dsh-agent-swarm/skills/plugin
 */
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import { TeamDomainError } from '../domain/error.js'
import { SkillsManagementStore, skillsManagementDomainSpec } from '../storage/skills-management.js'
import { SkillsManagementModule, type SkillsManagementConfig } from './module.js'
import { registerSkillsManagementTools } from '../tools/skills-management.js'

export const name = 'skills-management'

export const inject = [
  'agentSwarm',
  'tools',
  'agents',
  'sessions',
  'storageDomain',
] as const

/** Host-owned plugin config. The manager model route is separate from the Team default. */
export const Config = z.object({
  manager: z.object({ provider: z.string().min(1).optional(), model: z.string().min(1).optional() }).strict().default({}),
  management: z.array(z.object({ scope: z.string().min(1), teamId: z.string().min(1) }).strict()).default([]),
  activityPageSize: z.number().int().min(1).max(100).default(50),
}).strict()
export type SkillsManagementPluginConfig = z.input<typeof Config>

function resolveConfig(raw: SkillsManagementPluginConfig): SkillsManagementConfig {
  const parsed = Config.parse(raw)
  const provider = parsed.manager.provider
  const model = parsed.manager.model
  // A half-declared manager route would strand every investigation: fail loud
  // at the earliest determinable point. BOTH or NEITHER — with neither, the
  // module answers requests with an explicit `unavailable`, never a stall.
  if ((provider === undefined) !== (model === undefined)) {
    throw new TeamDomainError('skills-management manager requires both provider and model, or neither', 'SKILLS_CONFIG_INVALID')
  }
  const seen = new Set<string>()
  for (const entry of parsed.management) {
    const key = `${entry.scope}\u0000${entry.teamId}`
    if (seen.has(key)) throw new TeamDomainError('duplicate management manifest entry', 'SKILLS_CONFIG_INVALID')
    seen.add(key)
  }
  return {
    manager: { ...(provider === undefined ? {} : { provider }), ...(model === undefined ? {} : { model }) },
    management: parsed.management.map(entry => ({ scope: entry.scope, teamId: entry.teamId })),
    activityPageSize: parsed.activityPageSize,
  }
}

/** Mounts the module: durable domain open happens before apply resolves. */
export async function apply(ctx: Context, raw: SkillsManagementPluginConfig): Promise<void> {
  const config = resolveConfig(raw)
  const domain = await ctx.storageDomain.open(skillsManagementDomainSpec)
  const store = new SkillsManagementStore(ctx, domain)
  let moduleInstance: SkillsManagementModule | undefined
  let unprovide: (() => void) | undefined
  const close = async (): Promise<void> => {
    unprovide?.()
    unprovide = undefined
    // Admission close → in-flight drain → module-owned manager handle release
    // → store close: all inside module.close(); the domain closes last.
    await moduleInstance?.close()
    await domain.close()
  }
  try {
    const runtime = ctx.agentSwarm
    moduleInstance = new SkillsManagementModule(ctx, store, {
      domain: runtime.domain,
      listTeamAggregates: scope => runtime.listTeamAggregates(scope),
      scopeOf: agent => runtime.scopeOf(agent),
    }, config)
    registerSkillsManagementTools(ctx, moduleInstance)
    ctx.effect(() => {
      unprovide = ctx.provide('agentSwarmSkills', moduleInstance!)
      return () => close()
    }, 'skills-management: module lifecycle')
    // Bounded startup recovery by the single module owner: manifest requests
    // left received/investigating by an interrupted lifetime are re-woken on
    // the resumed manager identity (no second scheduler, no Captain replay).
    await moduleInstance.startRecovery()
  } catch (error) {
    await close()
    throw error
  }
}
