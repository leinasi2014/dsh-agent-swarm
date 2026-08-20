/**
 * Bridge-local script-realm materialization and failure rendering for the
 * Team bridge workflow engine (M2-1, issue #75).
 *
 * Semantics mirror the official worker-thread engine's realm module
 * (`packages/workflow/workflow-worker-thread/src/realm.ts` at the rc.8
 * baseline) line for line of behavior: values leaving the script vm become
 * plain host JSON, cycles/sparse arrays/exotic prototypes/symbol keys are
 * rejected by path, and thrown values render without ever throwing. The
 * bridge deliberately does not depend on the official engine package so a
 * Profile can compose the bridge without the worker-thread engine
 * (design note §4.3, docs/development/2026-08-21-m2a-workflow-bridge-design.md).
 * @module dsh-agent-swarm/runtime/workflow/realm
 */

/** Thrown by {@link materializeFromRealm}; the caller wraps it into `RESULT_UNSERIALIZABLE`. */
export class MaterializeError extends Error {
  constructor(
    public readonly path: string,
    public readonly reason: string,
  ) {
    super(`${path}: ${reason}`)
    this.name = 'MaterializeError'
  }
}

/**
 * Render a thrown value to failure text without ever throwing: prefer
 * `stack`, then `message`, then `String()`. Reading those properties MAY run
 * script code (a getter, `toString`); if that code itself throws, a fixed
 * label is returned — rendering must stay total for the never-reject result.
 * @param error - any value thrown in the host or script realm.
 * @returns human-readable text for the failure report.
 */
export function renderThrown(error: unknown): string {
  try {
    const stack = (error as { stack?: unknown } | null | undefined)?.stack
    if (typeof stack === 'string' && stack.length > 0) return stack
    const message = (error as { message?: unknown } | null | undefined)?.message
    if (typeof message === 'string' && message.length > 0) return message
    return String(error)
  } catch {
    return '[unrenderable thrown value]'
  }
}

/**
 * Whether an object's prototype chain represents a plain data object: `null`,
 * or a prototype whose own prototype is `null` (the realm's
 * `Object.prototype`, not comparable by identity across realms).
 */
function hasPlainPrototype(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value)
  if (proto === null) return true
  return Object.getPrototypeOf(proto) === null
}

/**
 * Copy a script-realm value into plain host JSON data. Root `undefined` is
 * returned unchanged; nested `undefined` and values JSON cannot represent
 * losslessly fail with the offending path.
 * @param value - the script-realm value to materialize.
 * @param root - the path label for the root value (error messages).
 * @returns the host-realm copy (plain objects/arrays/scalars only).
 * @throws {@link MaterializeError} for unsupported values, cycles, sparse
 *   arrays, exotic prototypes, or property reads that throw.
 */
export function materializeFromRealm(value: unknown, root = 'value'): unknown {
  if (value === undefined) return undefined
  try {
    return materialize(value, root, new Set())
  } catch (error: unknown) {
    if (error instanceof MaterializeError) throw error
    throw new MaterializeError(root, `reading the value threw: ${renderThrown(error)}`)
  }
}

function materialize(value: unknown, path: string, seen: Set<object>): unknown {
  switch (typeof value) {
    case 'boolean':
    case 'string':
      return value
    case 'number': {
      if (!Number.isFinite(value)) throw new MaterializeError(path, 'non-finite numbers are not JSON data')
      return value
    }
    case 'bigint':
      throw new MaterializeError(path, 'bigints are not JSON data')
    case 'function':
      throw new MaterializeError(path, 'functions are not plain JSON data')
    case 'symbol':
      throw new MaterializeError(path, 'symbols are not plain JSON data')
    case 'undefined':
      throw new MaterializeError(path, 'undefined is not JSON data')
    case 'object':
      break
  }
  if (value === null) return null
  const objectValue: object = value
  if (seen.has(objectValue)) throw new MaterializeError(path, 'circular references are not JSON data')
  seen.add(objectValue)
  try {
    if (Array.isArray(objectValue)) return materializeArray(objectValue, path, seen)
    return materializeObject(objectValue, path, seen)
  } finally {
    seen.delete(objectValue)
  }
}

function materializeArray(value: unknown[], path: string, seen: Set<object>): unknown[] {
  const out: unknown[] = []
  for (let index = 0; index < value.length; index++) {
    if (!(index in value)) throw new MaterializeError(`${path}[${index}]`, 'sparse arrays are not JSON data')
    out.push(materialize(value[index], `${path}[${index}]`, seen))
  }
  for (const key of Object.keys(value)) {
    const index = Number(key)
    if (!Number.isInteger(index) || index < 0 || index >= value.length) {
      throw new MaterializeError(`${path}.${key}`, 'arrays with non-index properties are not JSON data')
    }
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new MaterializeError(path, 'symbol-keyed properties are not plain JSON data')
  }
  return out
}

function materializeObject(value: object, path: string, seen: Set<object>): Record<string, unknown> {
  if (!hasPlainPrototype(value)) {
    throw new MaterializeError(path, 'only plain objects and arrays are JSON data (exotic prototype)')
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new MaterializeError(path, 'symbol-keyed properties are not plain JSON data')
  }
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value)) {
    // defineProperty, never assignment: a "__proto__" key must become an OWN
    // data property of the copy, not a prototype mutation.
    Object.defineProperty(out, key, {
      value: materialize((value as Record<string, unknown>)[key], `${path}.${key}`, seen),
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return out
}
