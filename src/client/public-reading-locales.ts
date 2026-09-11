export const publicReadingEn = {
  'public.replyOutside': "Reply to a message outside the loaded page",
  'public.statsThousand': 'K', 'public.statsMillion': 'M',
  'public.statsScope': 'Current Session · {name}', 'public.statsCounts': '{turns} turns · {steps} steps',
  'public.statsUsage': 'Token usage', 'public.statsTime': 'Session statistics', 'public.closeStats': 'Close statistics',
  'public.statsInput': 'Uncached input', 'public.statsRead': 'Cache read', 'public.statsWrite': 'Cache write', 'public.statsOutput': 'Output', 'public.statsTotal': 'Total tokens',
  'public.statsTurns': 'Turns', 'public.statsSteps': 'Steps', 'public.statsSpeed': 'Average output speed (tok/s)', 'public.statsLlmMs': 'LLM time (ms)', 'public.statsToolMs': 'Tool time (ms)',
  'public.statsSource': 'Cumulative statistics for this Session. Average output speed uses total decoded tokens / total decode time; these are not group-wide or per-message usage figures. Missing measurements are —.',

  'public.jumpLatest': 'Jump to latest', 'public.activityTop': 'Task activity · conversation top',
  'public.expand': 'Expand', 'public.collapse': 'Collapse', 'public.expandText': 'Read full text', 'public.collapseText': 'Collapse text',
  'public.openOriginal': 'Go to original message', 'public.closeQuote': 'Close quote', 'work.loadedCount': '{count} loaded',
} as const

export const publicReadingZh: Record<keyof typeof publicReadingEn, string> = {
  'public.replyOutside': "引用的消息不在当前已加载页中",
  'public.statsThousand': 'K', 'public.statsMillion': 'M',
  'public.statsScope': '当前会话 · {name}', 'public.statsCounts': '{turns} 轮 · {steps} 步',
  'public.statsUsage': 'Token 用量', 'public.statsTime': '会话统计', 'public.closeStats': '关闭统计',
  'public.statsInput': '未缓存输入', 'public.statsRead': '缓存读取', 'public.statsWrite': '缓存写入', 'public.statsOutput': '输出', 'public.statsTotal': '总 token',
  'public.statsTurns': '轮数', 'public.statsSteps': '步数', 'public.statsSpeed': '平均输出速度 (tok/s)', 'public.statsLlmMs': '模型耗时 (ms)', 'public.statsToolMs': '工具耗时 (ms)',
  'public.statsSource': '当前会话的累计统计。平均输出速度按累计输出 token / 累计解码时间计算；不代表群总量或单条群消息用量。缺少的测量显示 —。',

  'public.jumpLatest': '跳到最新', 'public.activityTop': '任务活动 · 群聊顶部',
  'public.expand': '展开', 'public.collapse': '收起', 'public.expandText': '展开全文', 'public.collapseText': '收起正文',
  'public.openOriginal': '定位原消息', 'public.closeQuote': '关闭引用', 'work.loadedCount': '已载入 {count} 条',
}
