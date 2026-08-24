import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fail } from './diagnostics.mjs'

const generatedRelativeRoot = 'docs/generated/knowledge-graph'

function assertFileNames(files) {
  for (const name of files.keys()) {
    if (name !== basename(name) || name.includes('/') || name.includes('\\')) fail('KG_GENERATED_NAME', `invalid generated filename: ${name}`)
  }
}

export function resolveGeneratedOutputRoot(projectRoot, requested = generatedRelativeRoot) {
  if (requested !== generatedRelativeRoot) fail('KG_OUTPUT_SCOPE', `output must be the exact canonical path ${generatedRelativeRoot}`)
  if (isAbsolute(requested)) fail('KG_OUTPUT_SCOPE', 'absolute output paths are forbidden')
  const expected = resolve(projectRoot, generatedRelativeRoot)
  const target = resolve(projectRoot, requested)
  if (target !== expected) fail('KG_OUTPUT_SCOPE', `output must be exactly ${generatedRelativeRoot}`)
  const rel = relative(projectRoot, target)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail('KG_OUTPUT_SCOPE', 'output must be a bounded child of the repository')
  let cursor = projectRoot
  for (const part of rel.split(/[\\/]/u)) {
    cursor = join(cursor, part)
    if (!existsSync(cursor)) break
    const stat = lstatSync(cursor)
    if (stat.isSymbolicLink()) fail('KG_OUTPUT_SYMLINK', `output path crosses a symbolic link or junction: ${cursor}`)
    const real = realpathSync(cursor)
    const realRel = relative(projectRoot, real)
    if (realRel === '..' || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) fail('KG_OUTPUT_SYMLINK', `output path resolves outside the repository: ${cursor}`)
  }
  return target
}

export async function writeGeneratedFiles(outputRoot, files) {
  assertFileNames(files)
  await mkdir(outputRoot, { recursive: true })
  const expected = new Set(files.keys())
  for (const entry of await readdir(outputRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !expected.has(entry.name)) fail('KG_GENERATED_FILESET', `unexpected generated-directory entry: ${entry.name}`)
  }
  for (const [name, content] of files) await writeFile(join(outputRoot, name), content, 'utf8')
}

export async function compareGeneratedFiles(outputRoot, files) {
  assertFileNames(files)
  let entries
  try {
    entries = await readdir(outputRoot, { withFileTypes: true })
  } catch {
    fail('KG_GENERATED_MISSING', `generated directory is missing: ${outputRoot}`)
  }
  const unexpected = entries.find(entry => !entry.isFile())
  if (unexpected) fail('KG_GENERATED_FILESET', `unexpected generated-directory entry: ${unexpected.name}`)
  const names = entries.map(entry => entry.name).sort()
  const expected = [...files.keys()].sort()
  if (JSON.stringify(names) !== JSON.stringify(expected)) fail('KG_GENERATED_FILESET', `expected ${expected.join(', ')}, found ${names.join(', ')}`)
  for (const [name, content] of files) {
    const actual = await readFile(join(outputRoot, name), 'utf8')
    if (actual !== content) fail('KG_GENERATED_DRIFT', `${name} differs from deterministic output`)
  }
}
