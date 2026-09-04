/** Compact dependency DAG for the Tasks view (P0-2 S5c). Pure client layout. */
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SwarmHostReadProjectionV1 } from '../host/host-read-types.js'

type DagTask = SwarmHostReadProjectionV1['tasks'][number]

interface DagNode { readonly task: DagTask; readonly x: number; readonly y: number }
interface DagEdge { readonly from: string; readonly to: string; readonly path: string }
interface DagLayout { readonly width: number; readonly height: number; readonly nodes: readonly DagNode[]; readonly edges: readonly DagEdge[] }

const NODE_WIDTH = 112
const NODE_HEIGHT = 42
const COLUMN_GAP = 26
const ROW_GAP = 8

/** Group tasks by dependency depth (cycle-safe) and lay columns left to right. */
function compactTaskDag(tasks: readonly DagTask[]): DagLayout {
  const ids = new Set(tasks.map(task => task.id))
  const depth = new Map<string, number>()
  const visit = (id: string, seen: Set<string>): number => {
    if (depth.has(id)) return depth.get(id)!
    if (seen.has(id)) return 0
    seen.add(id)
    const task = tasks.find(candidate => candidate.id === id)
    let result = 0
    for (const dependency of task?.blockedBy ?? []) {
      if (!ids.has(dependency)) continue
      result = Math.max(result, visit(dependency, seen) + 1)
    }
    seen.delete(id)
    depth.set(id, result)
    return result
  }
  for (const task of tasks) visit(task.id, new Set<string>())
  const byDepth = new Map<number, DagTask[]>()
  for (const task of tasks) {
    const column = depth.get(task.id) ?? 0
    const bucket = byDepth.get(column) ?? []
    bucket.push(task)
    byDepth.set(column, bucket)
  }
  const columns = [...byDepth.keys()].toSorted((left, right) => left - right)
  const nodes: DagNode[] = []
  for (const column of columns) {
    const bucket = (byDepth.get(column) ?? []).toSorted((left, right) => left.id.localeCompare(right.id))
    bucket.forEach((task, row) => nodes.push({ task, x: column * (NODE_WIDTH + COLUMN_GAP), y: row * (NODE_HEIGHT + ROW_GAP) }))
  }
  const position = new Map(nodes.map(node => [node.task.id, node]))
  const edges: DagEdge[] = []
  for (const node of nodes) {
    for (const dependency of node.task.blockedBy) {
      const source = position.get(dependency)
      if (source === undefined) continue
      const x1 = source.x + NODE_WIDTH
      const y1 = source.y + NODE_HEIGHT / 2
      const x2 = node.x
      const y2 = node.y + NODE_HEIGHT / 2
      edges.push({ from: dependency, to: node.task.id, path: `M${x1} ${y1}C${x1 + 14} ${y1},${x2 - 14} ${y2},${x2} ${y2}` })
    }
  }
  const rows = Math.max(1, ...columns.map(column => byDepth.get(column)?.length ?? 1))
  return {
    width: columns.length * NODE_WIDTH + Math.max(0, columns.length - 1) * COLUMN_GAP,
    height: rows * NODE_HEIGHT + (rows - 1) * ROW_GAP,
    nodes,
    edges,
  }
}

function tone(status: DagTask['status']): string {
  if (status === 'in_progress') return 'running'
  if (status === 'submitted' || status === 'verifying') return 'pending'
  if (status === 'completed') return 'completed'
  if (status === 'failed') return 'failed'
  if (status === 'cancelled') return 'cancelled'
  return 'open'
}

const DAG_CSS = `
[data-swarm-task-dag]{display:flex;flex-direction:column;gap:6px;margin:0 0 10px;padding:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow-x:auto}
[data-swarm-task-dag] .swarm-team-workspace__dag-canvas{position:relative;flex:none}
[data-swarm-task-dag] svg{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
[data-swarm-task-dag] path{fill:none;stroke:var(--dsw-alias-border-l3);stroke-width:1.4}
[data-swarm-task-dag] .swarm-team-workspace__dag-node{position:absolute;display:flex;flex-direction:column;gap:2px;padding:5px 7px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
[data-swarm-task-dag] .swarm-team-workspace__dag-node[data-swarm-dag-tone="running"]{border-color:color-mix(in srgb, var(--dsw-alias-state-business-primary) 55%, var(--dsw-alias-border-l2));box-shadow:0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-business-primary) 8%, transparent)}
[data-swarm-task-dag] .swarm-team-workspace__dag-node[data-swarm-dag-tone="pending"]{border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 55%, var(--dsw-alias-border-l2))}
[data-swarm-task-dag] .swarm-team-workspace__dag-node[data-swarm-dag-tone="completed"]{border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 55%, var(--dsw-alias-border-l2))}
[data-swarm-task-dag] .swarm-team-workspace__dag-node[data-swarm-dag-tone="failed"]{border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 55%, var(--dsw-alias-border-l2))}
[data-swarm-task-dag] .swarm-team-workspace__dag-node[data-swarm-dag-tone="cancelled"]{opacity:.55}
[data-swarm-task-dag] .swarm-team-workspace__dag-id{font-size:9.5px;font-weight:700}
[data-swarm-task-dag] .swarm-team-workspace__dag-subject{overflow:hidden;font-size:9.5px;color:var(--dsw-alias-label-secondary);text-overflow:ellipsis;white-space:nowrap}
[data-swarm-task-dag] .swarm-team-workspace__dag-hint{color:var(--dsw-alias-label-tertiary);font-size:9px}
`

/** Heads the Tasks tab with the dependency graph; hidden when no tasks. */
export function TaskDag({ tasks, t }: { readonly tasks: readonly DagTask[]; readonly t: TranslateNS<'swarm.team-dashboard'> }) {
  if (tasks.length === 0) return null
  const layout = compactTaskDag(tasks)
  return (
    <section className="swarm-team-workspace" data-swarm-task-dag aria-label={t('dag.title')}>
      <style>{DAG_CSS}</style>
      <div className="swarm-team-workspace__block-head"><span>{t('dag.title')}</span><small>{t('dag.hint')}</small></div>
      <div className="swarm-team-workspace__dag-canvas" style={{ width: layout.width, height: layout.height }}>
        <svg width={layout.width} height={layout.height} aria-hidden="true">
          {layout.edges.map(edge => <path key={`${edge.from}:${edge.to}`} d={edge.path} data-swarm-dag-edge data-from={edge.from} data-to={edge.to} />)}
        </svg>
        {layout.nodes.map(node => (
          <div
            key={node.task.id}
            className="swarm-team-workspace__dag-node"
            style={{ left: node.x, top: node.y, width: NODE_WIDTH, height: NODE_HEIGHT }}
            data-swarm-dag-node={node.task.id}
            data-swarm-task-status={node.task.status}
            data-swarm-dag-tone={tone(node.task.status)}
            title={node.task.subject}
          >
            <span className="swarm-team-workspace__dag-id">{node.task.id}</span>
            <span className="swarm-team-workspace__dag-subject">{node.task.subject}</span>
          </div>
        ))}
      </div>
    </section>
  )
}


