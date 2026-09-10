/** Goal tools project public state; private operation receipts never leave Domain. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { TaskId } from '../domain/types.js'
import { controlGoalInputSchema, goalCoordinationSchema, goalSnapshotSchema, saveGoalInputSchema } from '../shared/goal-lifecycle.js'
import { requireAgent, type ToolExecutionAuthority } from '../runtime/authority.js'
import type { AgentSwarmRuntime } from '../runtime/orchestrator-runtime.js'
import { register } from './shared.js'

const team = z.string().min(1).max(256).optional()
const save = saveGoalInputSchema.extend({ team_id: team })
const control = controlGoalInputSchema.extend({ team_id: team })
const coordination = goalCoordinationSchema.omit({ actorSessionId: true, at: true })
const operationOutput = z.object({ snapshot: goalSnapshotSchema, operationRevision: z.number().int().positive(), replayed: z.boolean() }).strict()
const coordinationOutput = z.object({ snapshot: goalSnapshotSchema, replayed: z.boolean() }).strict()
const cancel = z.object({ request_id: z.string().min(1).max(256), task_id: z.string().min(1),
  expected_revision: z.number().int().nonnegative(), reason: z.string().min(1).max(4096) }).strict()
const cancelOutput = z.object({ task_id: z.string(), revision: z.number().int(), status: z.literal('cancelled'), replayed: z.boolean(),
  interruption: z.object({ state: z.enum(['not-needed', 'requested', 'skipped', 'failed', 'not-repeated']), reason: z.string().optional() }).strict() }).strict()

/** SDK alpha.2 exposes shape schemas; canonical Zod still enforces all bounds. */
function adaptShape(node: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(node)) {
      if (key === 'properties') result[key] = Object.fromEntries(Object.entries(value as Record<string, Record<string, unknown>>).map(([name, child]) => [name, adaptShape(child)]))
      else if (key === 'items') result[key] = adaptShape(value as Record<string, unknown>)
      // The only anyOf produced here is a positive integer or null.
      else if (key === 'oneOf' || key === 'anyOf') result.oneOf = (value as Record<string, unknown>[]).map(adaptShape)
      else if (['type', 'required', 'additionalProperties', 'enum', 'const', 'description', 'title'].includes(key)) result[key] = value
    }
    return result
}
function shapeSchema(schema: z.ZodType): Record<string, unknown> & NonNullable<Parameters<Context['tools']['register']>[0]['output']>['schema'] {
  return adaptShape(JSON.parse(JSON.stringify(z.toJSONSchema(schema))))
}

export function registerGoalTools(ctx: Context, runtime: AgentSwarmRuntime): void {
  function tool<I extends z.ZodType, O extends z.ZodType>(name: string, description: string, input: I, output: O,
    execute: (args: z.output<I>, exec: ToolExecutionAuthority) => Promise<z.input<O>>, read = false): void {
    register(ctx, { name, description, parameters: shapeSchema(input),
      output: { schema: shapeSchema(output), render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      isConcurrencySafe: () => read,
      async execute(args, exec) { return output.parse(await execute(input.parse(args), exec)) },
    }, 'goal lifecycle tool')
  }
  tool('agent_swarm_get_goal', 'Read the current Team goal, lifecycle, exact coordination trigger and token budget. Members read their own Team; owning Main supplies team_id. Reading starts no work.',
    z.object({ team_id: team }).strict(), goalSnapshotSchema, (args, exec) => runtime.goals.readAgent(exec, args.team_id), true)
  tool('agent_swarm_save_goal', 'Owning Main or Captain saves the unique Team goal. Use the current lifecycle revision (0 if absent) and a stable requestId; exact retries return the original receipt. start=true explicitly starts a round. Maintenance requires intervalMs and a finite token budget above usage. Goal fields are camelCase; team_id is needed only for Main.',
    save, operationOutput, async ({ team_id, ...input }, exec) => {
      const result = await runtime.goals.saveAgent(exec, input, team_id)
      return { snapshot: runtime.goals.project(runtime.scopeOf(requireAgent(exec)), result.team), operationRevision: result.operationRevision, replayed: result.replayed }
    })
  tool('agent_swarm_control_goal', 'Owning Main or Captain starts, pauses or resumes an existing goal using its exact lifecycle revision and a stable requestId. Pause holds new planning and task claims; existing attempts may finish. Maintenance resume requires finite token headroom. Fields are camelCase except team_id.',
    control, operationOutput, async ({ team_id, ...input }, exec) => {
      const result = await runtime.goals.controlAgent(exec, input, team_id)
      return { snapshot: runtime.goals.project(runtime.scopeOf(requireAgent(exec)), result.team), operationRevision: result.operationRevision, replayed: result.replayed }
    })
  tool('agent_swarm_coordinate_goal', 'Captain confirms the exact triggerId, goalRevision and resultSequence read from get_goal. Cite actual taskIds and evidence in summary. coordinated records a plan; achieved completes a finite goal; round-finished closes one maintenance round. Completion requires all tasks terminal and no active attempts. Superseded work must be deliberately cancelled before completion.',
    coordination, coordinationOutput, async ({ nextAction, ...input }, exec) => {
      const result = await runtime.goals.coordinate(exec, { ...input, ...(nextAction === undefined ? {} : { nextAction }) })
      return { snapshot: runtime.goals.project(runtime.scopeOf(requireAgent(exec)), result.team), replayed: result.replayed }
    })
  tool('agent_swarm_cancel_task', 'Captain deliberately cancels an obsolete task using a stable request_id and exact expected_revision. Preserves output/evidence and spent usage, fences its old attempt, and requests interruption only when its exact live execution is proven. Retrying the same request never interrupts again.',
    cancel, cancelOutput, async (input, exec) => {
      const result = await runtime.goals.cancel(exec, { requestId: input.request_id, taskId: TaskId(input.task_id), expectedTaskRevision: input.expected_revision, reason: input.reason })
      return { task_id: result.task.id, revision: result.task.revision, status: 'cancelled' as const, replayed: result.replayed, interruption: result.interruption }
    })
}
