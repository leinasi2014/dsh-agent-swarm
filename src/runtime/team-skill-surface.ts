/** Team-scoped Skill loader composition for newly provisioned continuable agents. */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { isModelInvocable, isSkillName, renderSkillContent } from '@deepseek-ai/dsh-skill'
import type { TeamState } from '../domain/types.js'

/**
 * Installs an exact `skill` tool shadow only for Team sessions with a persisted
 * allow-list. The tool reads the normal scoped Skill registry but refuses
 * names outside the Team's own immutable list.
 */
export class TeamSkillSurface {
  private readonly policies = new Map<string, readonly string[]>()

  constructor(ctx: Context) {
    ctx.subagents.registerContinuableSetup(childCtx => {
      const agent = childCtx.agent
      const names = agent === undefined ? undefined : this.policies.get(String(agent.id))
      if (names === undefined) return () => {}
      const allowed = new Set(names)
      childCtx.tools.register(allowedSkillTool(childCtx, allowed))
      childCtx.systemPrompt.section({
        name: 'agent-swarm:team-skills',
        order: 121,
        text: `This Team may load only these Skills: ${names.map(name => `\`${name}\``).join(', ')}. Do not request or load any other Skill.`,
      })
      return () => {}
    })
  }

  /** Bind the durable Team policy to its Captain and every current member. */
  rememberTeam(team: TeamState): void {
    if (team.allowedSkills === undefined) return
    this.policies.set(team.captainSessionId, team.allowedSkills)
    for (const member of team.members) this.policies.set(member.sessionId, team.allowedSkills)
  }

  /** Bind a just-created child before its continuable Session is published. */
  rememberChild(team: TeamState, sessionId: string): void {
    if (team.allowedSkills !== undefined) this.policies.set(sessionId, team.allowedSkills)
  }
}

function allowedSkillTool(ctx: Context, allowed: ReadonlySet<string>) {
  return defineTool({
    name: 'skill',
    description: 'Load the full instructions for one Skill that this Team is allowed to use.',
    parameters: {
      name: { type: 'string', required: true, description: 'The exact allowed Skill name.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          name: { type: 'string', required: true }, provider: { type: 'string', required: true },
          content: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderSkillContent(value) }],
    },
    async execute(args, exec) {
      if (!isSkillName(args.name)) throw new Error(`invalid Skill name "${args.name}"`)
      if (!allowed.has(args.name)) throw new Error(`Skill "${args.name}" is not allowed for this Team`)
      const lookup = { cwd: exec.agent?.session.header.cwd, signal: exec.signal, scope: exec.agent }
      const skill = await ctx.skills.get(args.name, lookup)
      if (skill === undefined || !isModelInvocable(skill)) throw new Error(`Skill "${args.name}" is unavailable for model invocation`)
      return { name: skill.name, provider: skill.provider, content: skill.content }
    },
    presentCall(args) { return { card: 'generic', title: `Load Skill ${args.name}`, kind: 'read', rawInput: args.name } },
  })
}
