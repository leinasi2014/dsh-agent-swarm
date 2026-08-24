import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { compareGeneratedFiles, resolveGeneratedOutputRoot, writeGeneratedFiles } from './knowledge-graph/io.mjs'
import { loadKnowledgeGraph } from './knowledge-graph/load.mjs'
import { renderAtlas } from './knowledge-graph/render.mjs'
import { formatFailure } from './knowledge-graph/diagnostics.mjs'
import { extractSourceFacts } from './knowledge-graph/extract-source.mjs'
import { loadAgentToolRegistry, validateAgentToolRegistryAgainstFacts } from './knowledge-graph/agent-tool-registry.mjs'

const args = process.argv.slice(2)
const valueAfter = (flag, fallback) => {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : fallback
}
const root = realpathSync(resolve(valueAfter('--root', fileURLToPath(new URL('..', import.meta.url)))))
const manifestPath = valueAfter('--manifest', 'docs/knowledge-graph/manifest.json')
const schemaPath = valueAfter('--schema', 'docs/knowledge-graph/schema/manifest.schema.json')
const outputRoot = resolveGeneratedOutputRoot(root, valueAfter('--out', 'docs/generated/knowledge-graph'))
const check = args.includes('--check')

try {
  const [{ manifest, summary }, toolRegistry, sourceFacts] = await Promise.all([
    loadKnowledgeGraph(root, manifestPath, schemaPath),
    loadAgentToolRegistry(root),
    extractSourceFacts(root),
  ])
  const sourceErrors = sourceFacts.diagnostics.filter(item => item.severity === 'error')
  if (sourceErrors.length > 0) throw new Error(`source extraction failed: ${JSON.stringify(sourceErrors)}`)
  validateAgentToolRegistryAgainstFacts(toolRegistry, sourceFacts)
  const files = renderAtlas(manifest, summary.digest, toolRegistry)
  if (check) await compareGeneratedFiles(outputRoot, files)
  else await writeGeneratedFiles(outputRoot, files)
  console.log(`Knowledge graph ${check ? 'generated output' : 'generation'}: PASS (${summary.nodeCount} nodes, ${summary.edgeCount} edges, ${summary.digest})`)
} catch (error) {
  console.error(formatFailure(error))
  process.exitCode = 1
}
