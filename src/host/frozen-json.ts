/** Deep-freeze one JSON-like projection without cloning its values. */
export function deepFreezeJson<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) deepFreezeJson(child)
  }
  return value
}
