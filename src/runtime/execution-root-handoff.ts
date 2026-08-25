import { cpSync, existsSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { TeamDomainError } from '../domain/error.js'
import type { AttemptId, TaskId } from '../domain/types.js'

export const EXECUTION_ROOT_HANDOFF = '.dsh-execution-root-handoff.json'
export const EXECUTION_ROOT_DEPENDENCIES = '.dsh-execution-root-dependencies.json'

const EXCLUDED = new Set([
  '.git', 'node_modules', '.dsh-execution-root.json', EXECUTION_ROOT_HANDOFF,
  EXECUTION_ROOT_DEPENDENCIES, '.dsh-execution-root.reclaimable.json',
])

export function copyPredecessorRoot(
  sourcePath: string,
  targetPath: string,
  sourceAttemptId: AttemptId,
  targetAttemptId: AttemptId,
): number {
  let copiedEntries = 0
  for (const entry of readdirSync(sourcePath, { withFileTypes: true })) {
    if (EXCLUDED.has(entry.name)) continue
    cpSync(join(sourcePath, entry.name), join(targetPath, entry.name), {
      recursive: true,
      force: true,
      filter: source => !EXCLUDED.has(basename(source)),
    })
    copiedEntries += 1
  }
  writeFileSync(join(targetPath, EXECUTION_ROOT_HANDOFF), `${JSON.stringify({
    version: 1, sourceAttemptId, targetAttemptId, copiedEntries, inheritedAt: Date.now(),
  }, null, 2)}\n`, 'utf8')
  return copiedEntries
}

export function copyDependencyScopes(
  sourceRoot: string,
  targetRoot: string,
  dependencyId: TaskId,
  writeScopes: readonly string[],
): string[] {
  const copiedScopes: string[] = []
  for (const declared of writeScopes) {
    const source = resolve(sourceRoot, declared)
    const destination = resolve(targetRoot, declared)
    const sourceRelative = relative(sourceRoot, source)
    const targetRelative = relative(targetRoot, destination)
    if (sourceRelative.startsWith('..') || isAbsolute(sourceRelative) || targetRelative.startsWith('..') || isAbsolute(targetRelative)) {
      throw new TeamDomainError(
        `dependency ${dependencyId} write scope escapes its execution root: ${declared}`,
        'TEAM_EXECUTION_ROOT_DEPENDENCY_CONFLICT',
      )
    }
    if (!existsSync(source)) continue
    cpSync(source, destination, {
      recursive: true,
      force: true,
      filter: candidate => !EXCLUDED.has(basename(candidate)),
    })
    copiedScopes.push(declared)
  }
  return copiedScopes
}

export function writeDependencyReceipt(
  targetRoot: string,
  targetAttemptId: AttemptId,
  dependencies: readonly { readonly taskId: TaskId; readonly attemptId: AttemptId; readonly copiedScopes: readonly string[] }[],
): void {
  writeFileSync(join(targetRoot, EXECUTION_ROOT_DEPENDENCIES), `${JSON.stringify({
    version: 1, targetAttemptId, dependencies, inheritedAt: Date.now(),
  }, null, 2)}\n`, 'utf8')
}
