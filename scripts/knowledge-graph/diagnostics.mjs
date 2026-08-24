export class KnowledgeGraphError extends Error {
  constructor(code, message, details = undefined) {
    super(`${code}: ${message}`)
    this.name = 'KnowledgeGraphError'
    this.code = code
    this.details = details
  }
}

export function fail(code, message, details = undefined) {
  throw new KnowledgeGraphError(code, message, details)
}

export function formatFailure(error) {
  if (error instanceof KnowledgeGraphError) return error.message
  return `KG_INTERNAL: ${error instanceof Error ? error.message : String(error)}`
}
