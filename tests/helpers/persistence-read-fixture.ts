/** Public read-handle fixture; accepts malformed stored evidence for fault tests. */
export function persistenceReadFixture(inspect: (id: string) => unknown) {
  return { open: async (id: string, mode: string) => {
    if (mode !== 'read') throw new Error('fixture only admits read handles')
    const value = await inspect(id)
    if (value === null || typeof value !== 'object' || !('meta' in value) || !('events' in value)) throw new Error('malformed stored fixture')
    return { header: value.meta, inheritedEventCount: 'inheritedEventCount' in value ? value.inheritedEventCount : 0,
      read: async () => ({ events: value.events }), close: async () => {} }
  } }
}
