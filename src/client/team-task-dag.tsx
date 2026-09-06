/** Interactive compact dependency DAG for the primary Team workbench. Pure client layout. */
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SwarmHostReadProjectionV1 } from '../host/host-read-types.js'

type DagTask = SwarmHostReadProjectionV1['tasks'][number]

interface DagNode { readonly task: DagTask; readonly x: number; readonly y: number }
interface DagEdge { readonly from: string; readonly to: string; readonly path: string }
interface DagLayout { readonly width: number; readonly height: number; readonly nodes: readonly DagNode[]; readonly edges: readonly DagEdge[] }

const NODE_WIDTH = 126
const NODE_HEIGHT = 48
const COLUMN_GAP = 30
const ROW_GAP = 10

/** Group tasks by dependency depth (cycle-safe) and lay columns left to right. */
function compactTaskDag(tasks: readonly DagTask[]): DagLayout {
  const ids = new Set(tasks.map(task => task.id))
  const byId = new Map(tasks.map(task => [task.id, task]))
  const depth = new Map<string, number>()
  const visit = (id: string, seen: Set<string>): number => {
    if (depth.has(id)) return depth.get(id)!
    if (seen.has(id)) return 0
    seen.add(id)
    const task = byId.get(id)
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
      edges.push({ from: dependency, to: node.task.id, path: `M${x1} ${y1}C${x1 + 16} ${y1},${x2 - 16} ${y2},${x2} ${y2}` })
    }
  }
  const rows = Math.max(1, ...columns.map(column => byDepth.get(column)?.length ?? 1))
  return {
    width: Math.max(NODE_WIDTH, columns.length * NODE_WIDTH + Math.max(0, columns.length - 1) * COLUMN_GAP),
    height: rows * NODE_HEIGHT + (rows - 1) * ROW_GAP,
    nodes,
    edges,
  }
}

function legacyTone(status: DagTask['status']): string {
  if (status === 'in_progress') return 'running'
  if (status === 'submitted' || status === 'verifying') return 'pending'
  if (status === 'completed') return 'completed'
  if (status === 'failed') return 'failed'
  if (status === 'cancelled') return 'cancelled'
  return 'open'
}

function semanticTone(task: DagTask, tasks: readonly DagTask[]): string {
  if (task.status !== 'pending') return legacyTone(task.status)
  const byId = new Map(tasks.map(candidate => [candidate.id, candidate]))
  return task.blockedBy.some(id => byId.get(id)?.status !== 'completed') ? 'blocked' : 'ready'
}

function related(tasks: readonly DagTask[], selectedId: string): { readonly upstream: string[]; readonly downstream: string[] } {
  const byId = new Map(tasks.map(task => [task.id, task]))
  const upstream = new Set<string>()
  const downstream = new Set<string>()
  const walkUp = (id: string): void => {
    for (const dependency of byId.get(id)?.blockedBy ?? []) {
      if (upstream.has(dependency)) continue
      upstream.add(dependency)
      walkUp(dependency)
    }
  }
  const walkDown = (id: string): void => {
    for (const task of tasks) {
      if (!task.blockedBy.includes(id) || downstream.has(task.id)) continue
      downstream.add(task.id)
      walkDown(task.id)
    }
  }
  walkUp(selectedId)
  walkDown(selectedId)
  return { upstream: [...upstream], downstream: [...downstream] }
}

const DAG_CSS = `
[data-swarm-task-dag]{display:flex;flex-direction:column;gap:7px;margin:0;padding:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
[data-swarm-task-dag] .swarm-team-workspace__dag-scroll{overflow-x:auto;scrollbar-width:thin}
[data-swarm-task-dag] .swarm-team-workspace__dag-canvas{position:relative;flex:none}
[data-swarm-task-dag] svg{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
[data-swarm-task-dag] path{fill:none;stroke:var(--dsw-alias-border-l3);stroke-width:1.4}
[data-swarm-task-dag] path[data-swarm-related="true"]{stroke:var(--dsw-alias-brand-primary);stroke-width:1.8}
[data-swarm-task-dag] .swarm-team-workspace__dag-node{position:absolute;display:flex;flex-direction:column;gap:2px;padding:6px 8px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:inherit;text-align:left;cursor:pointer}
[data-swarm-task-dag] [data-swarm-dag-node]:hover,[data-swarm-task-dag] .swarm-team-workspace__dag-node[aria-pressed="true"]{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,var(--dsw-alias-bg-layer-1))}
[data-swarm-task-dag] .swarm-team-workspace__dag-node[data-swarm-dag-state="running"]{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,var(--dsw-alias-border-l2))}
[data-swarm-task-dag] .swarm-team-workspace__dag-node[data-swarm-dag-state="pending"],[data-swarm-team-task-dag] .swarm-team-workspace__dag-node[data-swarm-dag-state="blocked"]{border-color:color-mix(in srgb,var(--dsw-alias-label-caution,var(--dsw-alias-brand-primary)) 55%,var(--dsw-alias-border-l2))}
[data-swarm-task-dag] .swarm-team-workspace__dag-node[data-swarm-dag-state="completed"]{border-color:color-mix(in srgb,var(--dsw-alias-label-positive,var(--dsw-alias-brand-primary)) 55%,var(--dsw-alias-border-l2))}
[data-swarm-task-dag] .swarm-team-workspace__dag-node[data-swarm-dag-state="failed"]{border-color:color-mix(in srgb,var(--dsw-alias-label-negative,var(--dsw-alias-label-secondary)) 55%,var(--dsw-alias-border-l2))}
[data-swarm-task-dag] .swarm-team-workspace__dag-node[data-swarm-dag-state="cancelled"]{opacity:.55}
[data-swarm-team-task-dag] .swarm-team-workspace__dag-id{font-size:9.5px;font-weight:700}
[data-swarm-task-dag] .swarm-team-workspace__dag-subject{overflow:hidden;font-size:9.5px;color:var(--dsw-alias-label-secondary);text-overflow:ellipsis;white-space:nowrap}
[data-swarm-task-dag] .swarm-team-workspace__dag-selected{display:grid;gap:6px;padding:8px;border-top:1px solid var(--dsw-alias-border-l2);font-size:10px}
[data-swarm-task-dag] .swarm-team-workspace__dag-selected strong,[data-swarm-task-dag] .swarm-team-workspace__dag-selected span{overflow-wrap:anywhere}
[data-swarm-task-dag] .swarm-team-workspace__dag-selected-grid{display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px 8px;color:var(--dsw-alias-label-secondary)}
[data-swarm-task-dag] .swarm-team-workspace__dag-selected-grid b{color:var(--dsw-alias-label-primary);font-weight:600}
[data-swarm-task-dag] .swarm-team-workspace__dag-detail-action{justify-self:start;padding:4px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;cursor:pointer}
`

export function TaskDag({ tasks, selectedTaskId, onSelectTask, onOpenTaskDetail, t }: {
  readonly tasks: readonly DagTask[]
  readonly selectedTaskId?: string
  readonly onSelectTask?: (taskId: string) => void
  readonly onOpenTaskDetail?: (taskId: string) => void
  readonly t: TranslateNS<'swarm.team-dashboard'>
}) {
  if (tasks.length === 0) return null
  const layout = compactTaskDag(tasks)
  const selected = tasks.find(task => task.id === selectedTaskId) ?? tasks[0]
  const relation = selected === undefined ? { upstream: [], downstream: [] } : related(tasks, selected.id)
  const relatedIds = new Set([...(selected === undefined ? [] : [selected.id]), ...relation.upstream, ...relation.downstream])
  return <section className="swarm-team-workspace__dag" data-swarm-task-dag aria-label={t('dag.title')}>
    <style>{DAG_CSS}</style>
    <div className="swarm-team-workspace__block-head"><span>{t('dag.title')}</span><small>{t('dag.hint')}</small></div>
    <div className="swarm-team-workspace__dag-scroll">
      <div className="swarm-team-workspace__dag-canvas" style={{ width: layout.width, height: layout.height }}>
        <svg width={layout.width} height={layout.height} aria-hidden="true">
          {layout.edges.map(edge => <path key={`${edge.from}:${edge.to}`} d={edge.path} data-swarm-dag-edge data-from={edge.from} data-to={edge.to} data-swarm-related={relatedIds.has(edge.from) && relatedIds.has(edge.to) ? 'true' : 'false'} />)}
        </svg>
        {layout.nodes.map(node => {
          const semantic = semanticTone(node.task, tasks)
          const pressed = selected?.id === node.task.id
          return <button
            key={node.task.id}
            className="swarm-team-workspace__dag-node"
            type="button"
            style={{ left: node.x, top: node.y, width: NODE_WIDTH, height: NODE_HEIGHT }}
            data-swarm-dag-node={node.task.id}
            data-swarm-task-status={node.task.status}
            data-swarm-dag-tone={legacyTone(node.task.status)}
            data-swarm-dag-state={semantic}
            aria-pressed={pressed}
            title={node.task.subject}
            onClick={() => { onSelectTask?.(node.task.id) }}
          >
            <span className="swarm-team-workspace__dag-id">{node.task.id}</span>
            <span className="swarm-team-workspace__dag-subject">{node.task.subject}</span>
          </button>
        })}
      </div>
    </div>
    {selected === undefined ? null : <div className="swarm-team-workspace__dag-selected" data-swarm-dag-selected-detail={selected.id}>
      <strong title={selected.subject}>{selected.subject}</strong>
      <div className="swarm-team-workspace__dag-selected-grid">
        <span>{t('taskOwner')}</span><b>{selected.ownerName ?? t('hostUnavailable')}</b>
        <span>{t('taskBlocked', { count: selected.blockedBy.length })}</span><b>{selected.blockedBy.length === 0 ? t('empty') : selected.blockedBy.join(', ')}</b>
        <span>{t('taskCurrentAttempt')}</span><b>{selected.currentAttemptId ?? t('memberNone')}</b>
        <span>↑</span><b>{relation.upstream.length === 0 ? t('empty') : relation.upstream.join(', ')}</b>
        <span>↓</span><b>{relation.downstream.length === 0 ? t('empty') : relation.downstream.join(', ')}</b>
      </div>
      {onOpenTaskDetail === undefined ? null : <button className="swarm-team-workspace__dag-detail-action" type="button" data-swarm-task-full-detail={selected.id} onClick={() => { onOpenTaskDetail(selected.id) }}>{t('manage.open')}</button>}
    </div>}
  </section>
}
