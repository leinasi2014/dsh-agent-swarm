import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { withLiveChild as runWithLiveChild } from '../../src/runtime/continuable-child.js'

/**
 * Exercise the actual callback lifetime; returning a child first would let
 * official continuation settlement retire it before the test operation.
 */
export async function withLiveChild<T>(ctx: Context, parent: Agent, childId: SessionId, signal: AbortSignal,
  operation: (child: Agent, signal: AbortSignal) => Promise<T> | T): Promise<T> {
  return await runWithLiveChild(ctx, parent, childId, signal, operation)
}
