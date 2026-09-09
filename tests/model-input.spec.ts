import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { expect, it } from 'vitest'
import { latestUserText } from './helpers/model-input.js'

const pluginMessage = (text: string, plugin = 'dsh-agent-swarm') => createUserMessage({
  content: [{ type: 'text', text }], source: { kind: 'plugin', plugin },
})

it('reads the assignment preceding an official runtime context snapshot', () => {
  expect(latestUserText({ messages: [
    pluginMessage('Task: task-current, revision 2'),
    pluginMessage('Runtime context snapshot', '@deepseek-ai/dsh-system-prompt'),
  ] })).toBe('Task: task-current, revision 2')
})

it('keeps newer peer mail instead of searching history for a stale assignment', () => {
  expect(latestUserText({ messages: [
    pluginMessage('Task: task-old, revision 1'),
    pluginMessage('The previous assignment is cancelled; acknowledge this message.'),
    pluginMessage('Task: task-old appears in context data', '@deepseek-ai/dsh-system-prompt'),
  ] })).toBe('The previous assignment is cancelled; acknowledge this message.')
})

it('does not exclude work by text resemblance or an unrecognized source', () => {
  expect(latestUserText({ messages: [pluginMessage('Runtime context snapshot: user work')] }))
    .toBe('Runtime context snapshot: user work')
  expect(latestUserText({ messages: [pluginMessage('Only context', '@deepseek-ai/dsh-system-prompt')] })).toBe('')
})
