import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseStrictJson } from './strict-json.mjs'
import { compileSchema, loadSchema } from './schema.mjs'
import { validateManifestSemantics } from './model.mjs'

export async function loadKnowledgeGraph(root, manifestPath, schemaPath) {
  const absoluteManifest = resolve(root, manifestPath)
  const absoluteSchema = resolve(root, schemaPath)
  const [raw, schema] = await Promise.all([readFile(absoluteManifest, 'utf8'), loadSchema(absoluteSchema)])
  const manifest = parseStrictJson(raw, manifestPath)
  compileSchema(schema)(manifest)
  const summary = validateManifestSemantics(root, manifest)
  return { manifest, summary }
}
