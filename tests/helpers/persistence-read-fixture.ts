/** Public read-handle fixture; accepts malformed stored evidence for fault tests. */
export function persistenceReadFixture(inspect: (id: string) => unknown, metadata?: (id: string) => unknown) {
  return { stat: async (id: string) => {
    if (metadata !== undefined) return { header: await metadata(id), revision: id }
    const value = await inspect(id)
    if (value === null || typeof value !== 'object' || !('meta' in value)) throw new Error('malformed stored metadata fixture')
    return { header: value.meta, revision: id }
  }, open: async (id: string, mode: string) => {
    if (mode !== 'read') throw new Error('fixture only admits read handles')
    const value = await inspect(id)
    if (value === null || typeof value !== 'object' || !('meta' in value) || !('events' in value)) throw new Error('malformed stored fixture')
    return { header: value.meta, inheritedEventCount: 'inheritedEventCount' in value ? value.inheritedEventCount : 0,
      read: async () => ({ events: value.events }), close: async () => {} }
  } }
}
