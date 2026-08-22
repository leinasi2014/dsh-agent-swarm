/**
 * Panel strings: the S0 copy contract. The zh dictionary is the key-set
 * source of truth (official locale convention, ui-subagent/src/client/locales.ts);
 * hosts fill the same keys from their own i18n (DSH locale namespace, Canvas
 * react-i18next). Components receive the resolved dictionary — never a t
 * function — so the shared layer stays free of any i18n dependency.
 */

/** Simplified Chinese dictionary (the StringsKey source of truth). */
export const zh = {
  'panel.title': 'Agent Swarm',
  'panel.loading': '正在加载 Team 状态…',
  'panel.error': 'Team 状态加载失败',
  'panel.empty': '暂无 Team 状态',
  'panel.degraded': '降级快照：仅计数与预算可用',
  'panel.stale': '数据可能已过期',
  'panel.refresh': '刷新',
  'counters.aria': 'Team 计数',
  'counters.total': '任务总数',
  'counters.completed': '已完成',
  'counters.ready': '就绪',
  'counters.queuedMessages': '排队消息',
  'counters.memoryEntries': '记忆条目',
  'budget.title': '预算用量',
  'budget.tokens': 'Token',
  'budget.requests': '请求',
  'budget.retries': '重试',
  'budget.observedAt': '观测于 {time}',
  'team.revision': '修订 {revision}',
  'team.activeMembers': '{count} 个活跃成员',
  'team.membersUnknown': '成员数未知',
  'team.detail': '查看详情',
  'tasks.aria': '任务列表',
  'tasks.title': '任务',
  'tasks.empty': '暂无任务',
  'task.status.pending': '待处理',
  'task.status.ready': '就绪',
  'task.status.in_progress': '进行中',
  'task.status.submitted': '已提交',
  'task.status.verifying': '验证中',
  'task.status.completed': '已完成',
  'task.status.failed': '已失败',
  'task.status.cancelled': '已取消',
  'task.unowned': '未认领',
  'task.attempts': '尝试 {count} 次',
  'task.blockedBy': '阻塞于',
  'task.blockedByMore': '等 {count} 项',
  'task.select': '查看任务 {title}',
} as const

/** Key domain of the panel dictionaries (zh is the source of truth). */
export type StringsKey = keyof typeof zh

/** A fully-resolved dictionary. Missing keys fail loud at the type boundary. */
export type SwarmStrings = Readonly<Record<StringsKey, string>>

/** Substitute `{name}` placeholders in a dictionary template. */
export function formatSwarmString(template: string, params: Readonly<Record<string, string | number>>): string {
  let out = template
  for (const [name, value] of Object.entries(params)) {
    out = out.replaceAll(`{${name}}`, String(value))
  }
  return out
}
