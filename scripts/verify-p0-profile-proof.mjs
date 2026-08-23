import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { verifyP0Evidence } from './p0/evidence.mjs'

const rootIndex = process.argv.indexOf('--root')
const commitIndex = process.argv.indexOf('--candidate-commit')
const treeIndex = process.argv.indexOf('--candidate-tree')
if ([rootIndex, commitIndex, treeIndex].some(index => index < 0)
  || [rootIndex, commitIndex, treeIndex].some(index => process.argv[index + 1] === undefined)) {
  console.error('usage: node scripts/verify-p0-profile-proof.mjs --root <proof-root> --candidate-commit <sha> --candidate-tree <sha>')
  process.exit(2)
}

const root = resolve(process.argv[rootIndex + 1])
const manifest = JSON.parse(await readFile(resolve(root, 'evidence', 'manifest.json'), 'utf8'))
const result = await verifyP0Evidence(root, manifest, {
  candidateCommit: process.argv[commitIndex + 1],
  candidateTree: process.argv[treeIndex + 1],
})
if (!result.ok) {
  for (const failure of result.failures) console.error(`P0 evidence: ${failure}`)
  process.exit(1)
}
console.log(`P0 immutable artifact and isolated official Profile evidence: PASS (${manifest.artifact.sha256})`)
