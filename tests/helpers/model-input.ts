import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

/** The latest work/inbox message, excluding only official context snapshots.
 * Never search for an older assignment: a newer peer message must win. */
export function latestUserText(options: Pick<GenerateOptions, 'messages'>): string {
  for (const message of options.messages.toReversed()) {
    if (message.role !== 'user') continue
    if (message.source.kind === 'plugin' && message.source.plugin === '@deepseek-ai/dsh-system-prompt') continue
    return message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
  }
  return ''
}
