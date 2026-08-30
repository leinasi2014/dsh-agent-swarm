/**
 * Jiuwen node-type mapping over the Team task DAG (M2-4, issue #78).
 *
 * A pattern-layer composition aid, deliberately NOT a workflow engine: the
 * five SwarmFlow node kinds (phase / parallel / pipeline / nested / human)
 * compile to an ordered sequence of plain `createTask` calls whose
 * dependencies are the board's native `blockedBy` edges. The compiler holds
 * no state, watches nothing and cancels nothing — every execution, fence,
 * quota, budget and review decision stays on the authoritative task board
 * (`AgentSwarmRuntime.createTask` and friends are the only mutation paths).
 *
 * The current mapping and fault-form contract is defined in docs/04.
 * @module dsh-agent-swarm/patterns/node-mapping
 */
import { TeamDomainError } from '../domain/error.js'
import type { CreateTaskInput } from '../domain/team-domain-port.js'
import type { TaskId, TeamTask } from '../domain/types.js'
import type { AgentSwarmRuntime, ToolExecutionAuthority } from '../runtime/orchestrator-runtime.js'

/** One plain work step (the Jiuwen `agent()` base unit). */
export interface TaskStepDecl {
  /** Non-empty subject line (the task's board subject). */
  readonly subject: string
  /** Non-empty description (the task's board description / prompt data). */
  readonly description: string
  /** Optional acceptance criteria carried verbatim. */
  readonly acceptanceCriteria?: readonly string[]
}

/** One pipeline item: its own ordered chain of stage steps. */
export interface PipelineItemDecl {
  /** Non-empty stage chain; stage s+1 consumes stage s's output artifact. */
  readonly stages: readonly TaskStepDecl[]
}

/** The five mapped node kinds plus the plain task base unit (closed set). */
export type PlanNodeDecl =
  | ({ readonly kind: 'task' } & TaskStepDecl)
  | {
    readonly kind: 'parallel'
    /** Fan-out label (diagnostics/grouping only). */
    readonly label: string
    /** Fan-out items: same entry edges, no intra edges, join at the exit. */
    readonly items: readonly TaskStepDecl[]
  }
  | {
    readonly kind: 'pipeline'
    /** Pipeline label (diagnostics/grouping only). */
    readonly label: string
    /** Per-item stage chains; zero cross-item edges (barrier-free). */
    readonly items: readonly PipelineItemDecl[]
  }
  | {
    readonly kind: 'nested'
    /** Non-empty subject of the delegated composition step. */
    readonly subject: string
    /** Non-empty description of the work the self-founded sub-Team executes. */
    readonly description: string
  }
  | {
    readonly kind: 'human'
    /** The question the human must answer at the review gate. */
    readonly question: string
    /** Optional decision context shown with the question. */
    readonly context?: string
  }

/** One serial stage: its nodes chain in declaration order (Jiuwen script order). */
export interface PhaseDecl {
  /** Non-empty phase title. */
  readonly title: string
  /** Optional phase description (grouping evidence only). */
  readonly description?: string
  /** Non-empty serial node list. */
  readonly nodes: readonly PlanNodeDecl[]
}

/** A declarative node plan: serial phases; the phase boundary is the join. */
export interface NodePlan {
  /** Non-empty plan name (diagnostics only — never a board field). */
  readonly name: string
  /** Non-empty plan description (diagnostics only). */
  readonly description: string
  /** Non-empty serial phase list. */
  readonly phases: readonly PhaseDecl[]
}

/** The createTask input shape the compiler emits (symbolic dependency keys). */
export type CompiledTaskInput = Omit<CreateTaskInput, 'blockedBy'> & { readonly blockedBy: readonly string[] }

/** One compiled task creation, in topological creation order. */
export interface CompiledTaskOp {
  /** Auto-assigned plan-local key (`k1`, `k2`, … creation order). */
  readonly key: string
  /** The node kind that produced this task. */
  readonly nodeKind: 'task' | 'parallel' | 'pipeline' | 'nested' | 'human'
  /** The phase title this task belongs to (grouping evidence). */
  readonly phase: string
  /** The createTask input with SYMBOLIC dependency keys (resolved at apply). */
  readonly input: CompiledTaskInput
}

/** One human review gate (the manual review leg of a `human` node). */
export interface CompiledReviewGate {
  /** Auto-assigned key of the gated task. */
  readonly taskKey: string
  /** The question the human answers with the review decision. */
  readonly question: string
  /** Optional decision context. */
  readonly context?: string
}

/** The pure compilation product: creation-order ops plus review gates. */
export interface CompiledNodePlan {
  readonly ops: readonly CompiledTaskOp[]
  readonly reviewGates: readonly CompiledReviewGate[]
  /** Task keys grouped by phase title (grouping evidence). */
  readonly phases: ReadonlyMap<string, readonly string[]>
}

/** The applied plan: real board tasks keyed by plan-local key. */
export interface AppliedNodePlan {
  /** Created tasks by plan-local key (creation order). */
  readonly tasks: ReadonlyMap<string, TeamTask>
  /** Created task ids grouped by phase title. */
  readonly phases: ReadonlyMap<string, readonly TaskId[]>
  /** Human review gates with their resolved task ids. */
  readonly reviewGates: readonly { readonly taskKey: string; readonly taskId: TaskId; readonly question: string; readonly context?: string }[]
}

/**
 * Failure-propagation contract appended to every BLOCKED task description:
 * the durable board HOLDS a blocked chain instead of auto-failing siblings
 * or downstream work (design note §4.1 — the deliberate divergence from
 * Jiuwen's in-process fail-fast).
 */
const HOLD_THE_CHAIN_NOTE = 'If a dependency does not complete, this task stays pending (ready=false) until the blocker is explicitly resolved — never skip, auto-fail or work around an unmet dependency.'

/** The self-Team contract appended to every compiled `nested` node task. */
const NESTED_CONTRACT = [
  'Nested composition contract: found your OWN sub-Team to execute this work (you become its captain),',
  'drive it explicitly (implicit membership resolution fails loud while you hold dual active Teams),',
  'archive the sub-Team before submitting, and fold its outcome into this task submission.',
  'Nesting is bounded to one level: second-level member spawns are refused by the delegation-depth cap.',
].join(' ')

/** The human-gate acceptance criteria set on every compiled `human` node task. */
const HUMAN_GATE_CRITERIA = [
  'Assemble the decision material answering the stated question and submit it; the submission then waits at the human review gate.',
  'Completion requires the human decision through the review transaction: accept = approval (carry the answer in the diagnostic), reject = refusal with rework.',
]

function nonEmptyString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TeamDomainError(`node plan ${what} must be a non-empty string`, 'TEAM_INPUT_INVALID')
  }
  return value
}

function nonEmptyArray<T>(value: readonly T[] | undefined, what: string): readonly T[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TeamDomainError(`node plan ${what} must be a non-empty array`, 'TEAM_INPUT_INVALID')
  }
  return value
}

/**
 * Compile one step into its createTask input. A blocked step carries the
 * hold-the-chain contract; a same-item pipeline stage additionally names its
 * upstream artifact with a `{upstream:<key>}` placeholder the applier
 * resolves to the real task id.
 */
function stepInput(step: TaskStepDecl, blockedBy: readonly string[], upstreamArtifactKey?: string): CompiledTaskInput {
  const description = nonEmptyString(step.description, 'task description')
  const parts = [description]
  if (upstreamArtifactKey !== undefined) {
    parts.push(
      `Input artifact: consume the completed output of task {upstream:${upstreamArtifactKey}} — it is the durable board record of the previous stage; the payload reaches you through Team mail or the captain's relay.`,
    )
  }
  if (blockedBy.length > 0) parts.push(HOLD_THE_CHAIN_NOTE)
  return {
    subject: nonEmptyString(step.subject, 'task subject'),
    description: parts.join('\n\n'),
    ...(step.acceptanceCriteria === undefined ? {} : {
      acceptanceCriteria: step.acceptanceCriteria.map(criterion => nonEmptyString(criterion, 'acceptance criterion')),
    }),
    blockedBy: [...blockedBy],
  }
}

/**
 * Compile a declarative node plan into the ordered `createTask` call
 * sequence (topological: every dependency precedes its dependents) plus the
 * human review-gate descriptors. Pure: no I/O, no board access, no state —
 * plan size bounds stay with the board's own admission.
 *
 * Compile algebra (design note §5.2): the plan is a serial phase sequence;
 * each phase is a serial node sequence; a node's ENTRY edges are the
 * previous element's exit frontier and its EXIT is its own task set —
 * `parallel` joins all items at the exit, `pipeline` chains stages per item
 * with zero cross-item edges, and the phase boundary is the join that
 * realizes the phase→dependency-chain mapping.
 * @param plan - the five-kind node declaration.
 * @returns creation-order ops, review gates and phase grouping.
 * @throws {@link TeamDomainError} `TEAM_INPUT_INVALID` for a malformed plan.
 */
export function compileNodePlan(plan: NodePlan): CompiledNodePlan {
  nonEmptyString(plan.name, 'name')
  nonEmptyString(plan.description, 'description')
  const phases = nonEmptyArray(plan.phases, 'phases')
  const ops: CompiledTaskOp[] = []
  const reviewGates: CompiledReviewGate[] = []
  const phaseGroups = new Map<string, string[]>()
  let frontier: string[] = []
  const emit = (nodeKind: CompiledTaskOp['nodeKind'], phase: string, input: CompiledTaskInput): string => {
    const key = `k${ops.length + 1}`
    ops.push({ key, nodeKind, phase, input })
    const group = phaseGroups.get(phase) ?? []
    group.push(key)
    phaseGroups.set(phase, group)
    return key
  }
  for (const phase of phases) {
    const title = nonEmptyString(phase.title, 'phase title')
    const nodes = nonEmptyArray(phase.nodes, `phase "${title}" nodes`)
    for (const node of nodes) {
      if (node === null || typeof node !== 'object' || !('kind' in node)) {
        throw new TeamDomainError('node plan node must be an object with a kind', 'TEAM_INPUT_INVALID')
      }
      switch (node.kind) {
        case 'task': {
          // Base unit: one task; the node's exit is itself.
          const key = emit('task', title, stepInput(node, frontier))
          frontier = [key]
          break
        }
        case 'parallel': {
          // Fan-out: every item shares the entry frontier, no intra edges;
          // the exit joins ALL items ("全部等齐" — the next element's entry).
          nonEmptyString(node.label, 'parallel label')
          const items = nonEmptyArray(node.items, `parallel "${node.label}" items`)
          frontier = items.map(item => emit('parallel', title, stepInput(item, frontier)))
          break
        }
        case 'pipeline': {
          // Barrier-free pipeline: item i stage s+1 depends only on item i
          // stage s. Zero cross-item edges; the exit is each item's last stage.
          nonEmptyString(node.label, 'pipeline label')
          const items = nonEmptyArray(node.items, `pipeline "${node.label}" items`)
          const exits: string[] = []
          for (const [itemIndex, item] of items.entries()) {
            const stages = nonEmptyArray(item.stages, `pipeline "${node.label}" item ${itemIndex} stages`)
            let previous: string | undefined
            for (const stage of stages) {
              const key = emit(
                'pipeline',
                title,
                stepInput(stage, previous === undefined ? frontier : [previous], previous),
              )
              previous = key
            }
            if (previous !== undefined) exits.push(previous)
          }
          frontier = exits
          break
        }
        case 'nested': {
          // One parent-board task whose assignee self-founds a sub-Team (the
          // F11 face) under the one-level nesting contract.
          const key = emit('nested', title, {
            subject: nonEmptyString(node.subject, 'nested subject'),
            description: [
              nonEmptyString(node.description, 'nested description'),
              NESTED_CONTRACT,
              ...(frontier.length > 0 ? [HOLD_THE_CHAIN_NOTE] : []),
            ].join('\n\n'),
            blockedBy: [...frontier],
          })
          frontier = [key]
          break
        }
        case 'human': {
          // Review-gate manual leg: a member task whose completion requires
          // the human decision at the review transaction. `submitted` at the
          // gate is the board's waiting_for_human form.
          const question = nonEmptyString(node.question, 'human question')
          const context = node.context === undefined ? undefined : nonEmptyString(node.context, 'human context')
          const key = emit('human', title, {
            subject: `Human decision gate: ${question}`,
            description: [
              'A human decision is required before this flow may proceed.',
              ...(context === undefined ? [] : [`Decision context: ${context}`]),
              `Question: ${question}`,
              ...(frontier.length > 0 ? [HOLD_THE_CHAIN_NOTE] : []),
            ].join('\n\n'),
            acceptanceCriteria: HUMAN_GATE_CRITERIA,
            blockedBy: [...frontier],
          })
          reviewGates.push({ taskKey: key, question, ...(context === undefined ? {} : { context }) })
          frontier = [key]
          break
        }
        default:
          throw new TeamDomainError(
            `node plan node kind must be one of task|parallel|pipeline|nested|human, got "${String((node as { kind: unknown }).kind)}"`,
            'TEAM_INPUT_INVALID',
          )
      }
    }
  }
  return {
    ops,
    reviewGates,
    phases: new Map([...phaseGroups].map(([title, keys]) => [title, [...keys]])),
  }
}

/** Resolve `{upstream:<key>}` artifact placeholders against created ids. */
function resolvePlaceholders(description: string, ids: ReadonlyMap<string, TaskId>): string {
  return description.replace(/\{upstream:(k\d+)\}/g, (whole, key: string) => {
    const id = ids.get(key)
    return id === undefined ? whole : id
  })
}

/**
 * Apply a node plan to one Team through the ONLY mutation path —
 * `runtime.createTask` — in the compiler's topological order, with symbolic
 * dependency keys resolved to the real `TaskId`s the board assigned. Each
 * call passes the unchanged board admission (graph validation, limits,
 * revision discipline) and triggers the ordinary scheduling pass; the
 * applier builds no state beyond the key→task map it returns.
 * @param runtime - the authoritative Team orchestrator.
 * @param exec - the caller's execution authority (a Team member session).
 * @param plan - the declarative plan.
 * @returns created tasks by key, phase grouping and resolved review gates.
 */
export async function applyNodePlan(
  runtime: AgentSwarmRuntime,
  exec: ToolExecutionAuthority,
  plan: NodePlan,
): Promise<AppliedNodePlan> {
  const compiled = compileNodePlan(plan)
  const tasks = new Map<string, TeamTask>()
  const ids = new Map<string, TaskId>()
  for (const op of compiled.ops) {
    const blockedBy: TaskId[] = []
    for (const key of op.input.blockedBy) {
      const upstreamId = ids.get(key)
      if (upstreamId === undefined) {
        throw new TeamDomainError(`node plan dependency "${key}" has no created task (compiler order violated)`, 'TEAM_INPUT_INVALID')
      }
      blockedBy.push(upstreamId)
    }
    const task = await runtime.createTask(exec, {
      subject: op.input.subject,
      description: resolvePlaceholders(op.input.description, ids),
      ...(op.input.acceptanceCriteria === undefined ? {} : { acceptanceCriteria: op.input.acceptanceCriteria }),
      blockedBy,
    })
    tasks.set(op.key, task)
    ids.set(op.key, task.id)
  }
  const phases = new Map<string, TaskId[]>()
  for (const [title, keys] of compiled.phases) {
    phases.set(title, keys.map(key => ids.get(key)!))
  }
  return {
    tasks,
    phases,
    reviewGates: compiled.reviewGates.map(gate => ({
      taskKey: gate.taskKey,
      taskId: ids.get(gate.taskKey)!,
      question: gate.question,
      ...(gate.context === undefined ? {} : { context: gate.context }),
    })),
  }
}
