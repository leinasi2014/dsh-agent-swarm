/** Read the official stored log without claiming its writer ownership. */
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionInspection, SessionPersistence } from '@deepseek-ai/dsh-session-persistence'

export async function readPersistedSession(
  persistence: SessionPersistence,
  id: SessionId,
  signal?: AbortSignal,
): Promise<SessionInspection> {
  const handle = await persistence.open(id, 'read', signal === undefined ? undefined : { signal })
  try {
    const { events } = await handle.read(0, undefined, signal === undefined ? undefined : { signal })
    return { meta: handle.header, inheritedEventCount: handle.inheritedEventCount, events }
  } finally { await handle.close() }
}
